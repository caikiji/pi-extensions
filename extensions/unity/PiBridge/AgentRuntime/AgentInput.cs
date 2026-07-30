#if UNITY_EDITOR
/*
 * AgentInput — 视觉 agent 的输入接管层（运行时 MonoBehaviour，Editor-only）。
 *
 * ─── 为什么是运行时脚本而不是 Editor 脚本 ───────────────────────────
 * AgentInput 需要每帧在游戏 Update 之后覆盖输入/驱动角色移动。Editor 脚本
 * （Assets/Editor/ 下）无法 AddComponent，也没有可靠的"游戏 Update 之后"
 * 钩子。作为运行时 MonoBehaviour，LateUpdate 天然在游戏 Update 之后执行，
 * 时序正确。
 *
 * ─── 为什么整个类用 #if UNITY_EDITOR 包裹 ───────────────────────────
 * AgentInput 是开发/调试用的 agent 输入接管工具，绝不能进打包的 app。
 * #if UNITY_EDITOR 让整个类在非 Editor build 中不存在——编译时直接剔除，
 * 不会增加包体，也不会被场景/prefab 引用（它是运行时动态 AddComponent 的
 * __AgentInput__ GameObject，不在任何场景里）。install 时落到
 * Assets/Scripts/AgentInput/，用户打包时这段代码自动消失。
 *
 * 旧 Input Manager（CourseProject 用的）无法注入 Input.GetAxisRaw，而游戏
 * PlayerController.Update 每帧用 Input 覆盖 moveInput 字段——所以覆盖字段
 * 走不通（无论什么时机都会被冲掉）。
 *
 * A+ 方案：禁用游戏控制器 + AgentInput 自己 CharacterController.Move，
 * 同时反射设游戏控制器的状态字段（CurrentPlanarSpeed/IsSprinting/IsGrounded）
 * 让 PlayerAnimator 读到正确值驱动行走/跑步动画。
 *   - TakeOver()：反射找到 PlayerController，设 enabled=false（游戏 Update
 *     不再跑，不读 Input、不移动），反射拿它身上的 CharacterController。
 *   - LateUpdate()：AgentInput 自己每帧 CharacterController.Move，方向由
 *     s_virtualMove + 相机朝向算出，速度取 walkSpeed/runSpeed，转向用
 *     SmoothDampAngle（和游戏一致），重力反射读 gravity。Move 之后反射
 *     设 CurrentPlanarSpeed/IsSprinting/IsGrounded —— PlayerAnimator.Update
 *     在 LateUpdate 之后跑（PlayerAnimator 是普通 Update，时序在 LateUpdate
 *     之前；但 Animator 参数由状态字段每帧更新驱动，SetFloat 用 dampTime
 *     平滑，单帧时序差不影响最终动画）。
 *   - Release()：PlayerController.enabled=true，游戏恢复控制。
 *
 * 这样完全绕过游戏的输入层，不依赖覆盖字段的时序，也不和游戏 Update 冲突，
 * 同时通过反射设状态字段让动画/脚步声等读状态的逻辑正常工作。
 * ─── 自描述 ────────────────────────────────────────────────────────
 * Describe() 返回 JSON，说明支持哪些动作 + 探测到的游戏结构。agent install
 * 后调 Describe() 就能读懂这个项目能做什么，无需人工开发。
 *
 * ─── 限制 ──────────────────────────────────────────────────────────
 *   - 反射探测依赖命名约定（PlayerController/CharacterController/moveInput/
 *     yaw/pitch/InputLock），不保证所有项目都能探测到。探测失败时 Describe
 *     报告 unsupported，agent 应回退到 Win32 方案。
 *   - 跳跃/交互：旧 Input Manager 的 GetKeyDown 无法注入。当前 Jump()/
 *     Interact() 仅置标记；完整支持需游戏有 public 方法或 profile 指定。
 *   - 直接设 private 字段/反射调方法是 fragile 的（游戏更新可能改名），
 *     但比改游戏代码侵入性小。AgentInputProfile 可固定字段名提高可靠性。
 *
 * License: MIT
 */

using System;
using System.Reflection;
using UnityEngine;
#if UNITY_EDITOR
using UnityEditor;
#endif

namespace PiBridge
{
    /// <summary>
    /// 视觉 agent 的输入接管层。运行时 MonoBehaviour（Editor-only）。
    /// 通过反射操作游戏对象的 CharacterController，完全不经过 OS 输入系统。
    /// agent 通过 PiBridge eval 调用静态方法（转发到单例）。
    /// </summary>
    public class AgentInput : MonoBehaviour
    {
        // ─── 单例 ──────────────────────────────────────────────────────
        // agent 通过 eval 调静态方法，静态方法转发到单例。单例自动创建。
        private static AgentInput _instance;
        private static AgentInput Instance
        {
            get
            {
                if (_instance == null)
                {
                    _instance = FindObjectOfType<AgentInput>();
                    if (_instance == null)
                    {
                        var go = new GameObject("__AgentInput__");
                        // HideAndDontSave：不进 Hierarchy、不随场景/Play 会话持久化，
                        // 域卸载时自动清理。普通 DontDestroyOnLoad 会把无组件的 GameObject
                        // 壳残留到后续 Play 会话（实测累积出多个 __AgentInput__ 残壳）。
                        go.hideFlags = HideFlags.HideAndDontSave;
                        _instance = go.AddComponent<AgentInput>();
                    }
                }
                return _instance;
            }
        }

        // ─── 接管状态 + 虚拟输入值（static，eval 直接设）──────────────
        private static bool s_takeover;
        private static bool s_allowPlayerControl;  // true=不禁用游戏控制器/不锁鼠标，人机共存
        private static Vector2 s_virtualMove = Vector2.zero;   // (-1~1, -1~1)
        private static bool s_virtualSprint;
        private static float s_virtualYawDelta;                // 本帧 yaw 增量（度）
        private static float s_virtualPitchDelta;
        private static bool s_virtualJump;                     // 本帧是否跳（消费后清零）
        private static bool s_virtualInteract;                 // 本帧是否交互（消费后清零）

        // ─── 按键事件模型（press/release，替代 duration 计时器）──────
        // 每个虚拟键记录是否按下 + 按下时刻（用于最大持续兜底）。
        // LateUpdate 从按键状态合成 s_virtualMove/s_virtualSprint/s_virtualYawDelta。
        // 这样 agent 像玩家一样“按住 W 走，松开 W 停”，而非猜 duration_ms。
        private const float MAX_KEY_HOLD = 5f;          // 单键最大持续秒，防模型忘松手
        private static bool s_keyW, s_keyA, s_keyS, s_keyD;
        private static bool s_keyShift;                  // 冲刺
        private static bool s_keyTurnLeft, s_keyTurnRight;
        private static double s_keyWTime, s_keyATime, s_keySTime, s_keyDTime;
        private static double s_keyShiftTime, s_keyTurnLeftTime, s_keyTurnRightTime;

        // ─── 持续动作计时器（替代协程）────────────────────────────────
        // duration_ms 范式：Move/Turn 设目标值 + 结束时刻，LateUpdate 计时器有效期间
        // 每帧维持目标值，超时清零。与 press/release 按键事件模型并存（后者优先级低）。
        private static double s_moveEndTime = -1;   // EditorApplication.timeSinceStartup
        private static Vector2 s_moveTarget = Vector2.zero;  // Move 目标方向，计时器维持
        private static double s_turnEndTime = -1;
        private static float s_turnPerFrameYaw;
        private static float s_turnPerFramePitch;

        // ─── 探测到的游戏结构（static，Describe/TakeOver/LateUpdate 共享）─
        private static bool s_probed;
        private static bool s_staleProbe;                    // Play 切换后置位，下次 ProbeStatic 强制重探
        private static MonoBehaviour s_playerController;       // 游戏的 PlayerController
        private static Type s_playerControllerType;
        private static FieldInfo s_moveInputField;
        private static FieldInfo s_sprintField;
        private static CharacterController s_charController;   // PlayerController 身上的
        private static float s_walkSpeed;
        private static float s_runSpeed;
        private static float s_turnSmoothTime = 0.12f;          // 转向平滑时间，反射读
        private static float s_gravity = -20f;                  // 重力，反射读
        // 游戏控制器状态属性的 setter（{ get; private set; } 反射拿 setter）
        // 设这些值让 PlayerAnimator 读到正确状态驱动动画。
        private static PropertyInfo s_planarSpeedProp;         // CurrentPlanarSpeed / Speed / moveAmount / velocity
        private static PropertyInfo s_isSprintingProp;         // IsSprinting
        private static PropertyInfo s_isGroundedProp;          // IsGrounded
        private static MonoBehaviour s_followCamera;           // 有 yaw/pitch 字段的脚本
        private static FieldInfo s_yawField;
        private static FieldInfo s_pitchField;
        private static float s_fixedPitch;                    // 接管时记录的纵向角度，固定不变
        private static float s_cameraYawSmoothVel;            // 相机 yaw 平滑速度
        private static Type s_inputLockType;
        private static PropertyInfo s_inputLockUiOpenProp;
        private static bool s_playerWasEnabled;                // TakeOver 前的 enabled，Release 恢复
        private static bool s_uiOpenWas;                       // TakeOver 前的 InputLock.UiOpen，Release 恢复
        // ─── 自管重力（游戏 Update 被禁用，重力得 AgentInput 管）────────
        private static float s_verticalVelocity;

        /// <summary>探测游戏结构。返回 JSON 描述支持的能力。</summary>
        public static string Describe()
        {
            ProbeStatic();
            var sb = new System.Text.StringBuilder();
            sb.Append("{");
            sb.Append("\"takeover\":").Append(s_takeover ? "true" : "false").Append(",");
            sb.Append("\"playerController\":");
            if (s_playerController != null)
            {
                sb.Append("{\"found\":true,\"type\":\"").Append(s_playerControllerType?.FullName ?? "null").Append("\"");
                sb.Append(",\"moveInput\":\"").Append(s_moveInputField?.Name ?? "null").Append("\"");
                sb.Append(",\"sprint\":\"").Append(s_sprintField?.Name ?? "null").Append("\"");
                sb.Append(",\"hasCharacterController\":").Append(s_charController != null ? "true" : "false");
                sb.Append(",\"walkSpeed\":").Append(s_walkSpeed);
                sb.Append(",\"runSpeed\":").Append(s_runSpeed);
                sb.Append(",\"turnSmoothTime\":").Append(s_turnSmoothTime);
                sb.Append(",\"gravity\":").Append(s_gravity);
                sb.Append(",\"planarSpeedProp\":\"").Append(s_planarSpeedProp?.Name ?? "null").Append("\"");
                sb.Append(",\"isSprintingProp\":\"").Append(s_isSprintingProp?.Name ?? "null").Append("\"");
                sb.Append(",\"isGroundedProp\":\"").Append(s_isGroundedProp?.Name ?? "null").Append("\"");
                sb.Append("}");
            }
            else sb.Append("{\"found\":false}");
            sb.Append(",\"followCamera\":");
            if (s_followCamera != null)
            {
                sb.Append("{\"found\":true,\"type\":\"").Append(s_followCamera.GetType().FullName).Append("\"");
                sb.Append(",\"yaw\":\"").Append(s_yawField?.Name ?? "null").Append("\"");
                sb.Append(",\"pitch\":\"").Append(s_pitchField?.Name ?? "null").Append("\"");
                sb.Append("}");
            }
            else sb.Append("{\"found\":false}");
            sb.Append(",\"inputLock\":");
            if (s_inputLockType != null)
            {
                sb.Append("{\"found\":true,\"type\":\"").Append(s_inputLockType.FullName).Append("\"}");
            }
            else sb.Append("{\"found\":false}");
            sb.Append(",\"isPlaying\":").Append(Application.isPlaying ? "true" : "false");
            sb.Append(",\"actions\":[\"move_forward\",\"move_backward\",\"move_left\",\"move_right\",\"turn_left\",\"turn_right\",\"interact\",\"jump\",\"wait\"]");
            sb.Append("}");
            return sb.ToString();
        }

        /// <summary>
        /// 开始接管输入。
        /// </summary>
        /// <param name="allowPlayerControl">
        /// false（默认）= 完全接管：禁用游戏 PlayerController、释放鼠标、设 InputLock，
        ///   玩家无法操控，agent 独占驱动角色。适合 agent 自动跑任务。
        /// true = 共享控制：不禁用 PlayerController、不锁鼠标，玩家可正常操控，
        ///   agent 的动作会与玩家输入并存（注意：游戏 Update 仍用 Input 覆盖 moveInput，
        ///   agent 通过 CharacterController.Move 驱动可能与玩家移动叠加，适合调试协助）。
        /// </param>
        public static string TakeOver(bool allowPlayerControl = false)
        {
            // 注意顺序：必须先拿单例再探测。首次创建单例时 AddComponent 触发 OnEnable
            // → ResetProbe()，会把刚探测到的引用清掉（real-world 首调 TakeOver 失效的根因）。
            var inst = Instance;
            ProbeStatic();
            s_takeover = true;
            s_allowPlayerControl = allowPlayerControl;
            // 记录原 UiOpen（两种模式都记）：完全接管会强制设 true，Release 据此恢复。
            s_uiOpenWas = GetInputLockUiOpen();
            if (!allowPlayerControl)
            {
                // 完全接管：禁用游戏 PlayerController（它的 Update 每帧用 Input 覆盖
                // moveInput 并调 CharacterController.Move，会和 AgentInput 双重移动 +
                // Input 冲掉虚拟输入）。记下原 enabled 以便 Release 恢复。
                if (s_playerController != null)
                {
                    s_playerWasEnabled = s_playerController.enabled;
                    s_playerController.enabled = false;
                }
                // 释放鼠标：游戏通常在 UI 关闭时 Cursor.lockState=Locked 捕获鼠标，
                // 这会抢走 OS 焦点、阻碍用户操作。接管期间强制解锁 + 显示光标，
                // LateUpdate 每帧维持（防游戏重新锁定）。
                Cursor.lockState = CursorLockMode.None;
                Cursor.visible = true;
                // 同时尝试设 InputLock.UiOpen=true（双保险：让游戏自己的输入逻辑也停）。
                // 原值已在上面记录，Release 时恢复——否则玩家依然无法操控。
                TrySetInputLockUiOpen(true);
                // 记录当前相机 pitch 作为固定纵向角度（接管期间不变），
                // yaw 改为跟随角色朝向（水平跟随），这样 WASD 就能完整操控。
                if (s_followCamera != null && s_pitchField != null)
                {
                    try { s_fixedPitch = (float)s_pitchField.GetValue(s_followCamera); } catch { }
                }
            }
            return "took over input: playerController=" + (s_playerController != null)
                + " charController=" + (s_charController != null)
                + " allowPlayerControl=" + allowPlayerControl
                + " (isPlaying=" + Application.isPlaying + ")";
        }

        /// <summary>释放输入，恢复游戏 PlayerController 控制。</summary>
        public static string Release()
        {
            s_takeover = false;
            s_allowPlayerControl = false;
            s_virtualMove = Vector2.zero;
            s_moveTarget = Vector2.zero;
            s_virtualSprint = false;
            s_virtualYawDelta = 0;
            s_virtualPitchDelta = 0;
            s_moveEndTime = -1;
            s_turnEndTime = -1;
            // 清空所有按键状态（防接管结束后角色还在动）
            s_keyW = s_keyA = s_keyS = s_keyD = false;
            s_keyShift = false;
            s_keyTurnLeft = s_keyTurnRight = false;
            if (s_playerController != null)
            {
                try { s_playerController.enabled = s_playerWasEnabled; } catch { }
            }
            // 恢复 InputLock.UiOpen 到 TakeOver 前的值（两种接管模式都恢复；共享模式
            // 下 TakeOver 没改过它，恢复为原值等于无操作）。完全接管强制设过 true，不恢复
            // 的话游戏输入逻辑（PlayerController/FollowCamera 查 UiOpen）会一直停在 UI 态。
            // SetUiOpen(false) 会连带恢复 Cursor.lockState=Locked（游戏默认游玩状态）。
            TrySetInputLockUiOpen(s_uiOpenWas);
            return "released input";
        }

        // ─── 高层动作 API（agent 通过 eval 调用）────────────────────────

        /// <summary>持续移动。x/z 是 -1~1，duration_ms 后停止。</summary>
        /// Move 设 s_moveTarget/s_moveEndTime，LateUpdate 在计时器有效期间每帧
        /// 维持 s_virtualMove=s_moveTarget（防被按键合成段覆盖）；超时清零。
        public static string Move(float x, float z, int durationMs)
        {
            ProbeStatic();
            s_moveTarget = new Vector2(x, z);
            s_virtualMove = s_moveTarget;
            s_moveEndTime = Time.realtimeSinceStartup + durationMs / 1000.0;
            return "move x=" + x + " z=" + z + " " + durationMs + "ms";
        }

        /// <summary>转向。yawDelta/pitchDelta 是度数总增量，duration_ms 内分摊到每帧。</summary>
        public static string Turn(float yawDelta, float pitchDelta, int durationMs)
        {
            ProbeStatic();
            float dt = Time.deltaTime;
            if (dt <= 0.0001f) dt = 0.0166f;
            float frames = Mathf.Max(1, (durationMs / 1000f) / dt);
            s_turnPerFrameYaw = yawDelta / frames;
            s_turnPerFramePitch = pitchDelta / frames;
            s_turnEndTime = Time.realtimeSinceStartup + durationMs / 1000.0;
            return "turn yaw=" + yawDelta + " pitch=" + pitchDelta + " " + durationMs + "ms";
        }

        /// <summary>交互（E 键等价）。下一帧消费后清零。</summary>
        public static string Interact()
        {
            s_virtualInteract = true;
            return "interact";
        }

        /// <summary>跳跃（Space 等价）。下一帧消费后清零。</summary>
        public static string Jump()
        {
            s_virtualJump = true;
            return "jump";
        }

        // ─── 按键事件 API（press/release，agent 像玩家一样操控）──────────
        // key 枚举（字符串，eval 传入）：W/A/S/D/Shift/TurnLeft/TurnRight
        // press 后键持续按下，直到 release 或超过 MAX_KEY_HOLD 自动 release。
        // LateUpdate 从按键状态合成移动/转向，替代旧的 duration 计时器。
        public static string PressKey(string key)
        {
            double now = Time.realtimeSinceStartup;
            switch (key)
            {
                case "W": s_keyW = true; s_keyWTime = now; break;
                case "A": s_keyA = true; s_keyATime = now; break;
                case "S": s_keyS = true; s_keySTime = now; break;
                case "D": s_keyD = true; s_keyDTime = now; break;
                case "Shift": s_keyShift = true; s_keyShiftTime = now; break;
                case "TurnLeft": s_keyTurnLeft = true; s_keyTurnLeftTime = now; break;
                case "TurnRight": s_keyTurnRight = true; s_keyTurnRightTime = now; break;
                default: return "unknown key: " + key;
            }
            return "pressed " + key;
        }

        public static string ReleaseKey(string key)
        {
            switch (key)
            {
                case "W": s_keyW = false; break;
                case "A": s_keyA = false; break;
                case "S": s_keyS = false; break;
                case "D": s_keyD = false; break;
                case "Shift": s_keyShift = false; break;
                case "TurnLeft": s_keyTurnLeft = false; break;
                case "TurnRight": s_keyTurnRight = false; break;
                default: return "unknown key: " + key;
            }
            return "released " + key;
        }

        /// <summary>返回当前按下的键（逗号分隔），供 agent 决策时知道哪些键还按着。</summary>
        public static string GetPressedKeys()
        {
            var sb = new System.Text.StringBuilder();
            if (s_keyW) sb.Append("W,");
            if (s_keyA) sb.Append("A,");
            if (s_keyS) sb.Append("S,");
            if (s_keyD) sb.Append("D,");
            if (s_keyShift) sb.Append("Shift,");
            if (s_keyTurnLeft) sb.Append("TurnLeft,");
            if (s_keyTurnRight) sb.Append("TurnRight,");
            string s = sb.ToString();
            return s.Length > 0 ? s.TrimEnd(',') : "(无)";
        }

        /// <summary>
        /// 返回 agent 当前状态 JSON：按住的键、角色位置/朝向、是否接地、平面速度。
        /// 每步决策前 eval 调用，作为文本注入 prompt（和图片并列），让模型明确当前持续行为。
        /// </summary>
        public static string GetAgentState()
        {
            ProbeStatic();
            var sb = new System.Text.StringBuilder();
            sb.Append("{");
            // 按住的键
            sb.Append("\"pressedKeys\":[");
            bool first = true;
            if (s_keyW) { if (!first) sb.Append(","); sb.Append("\"W\""); first = false; }
            if (s_keyA) { if (!first) sb.Append(","); sb.Append("\"A\""); first = false; }
            if (s_keyS) { if (!first) sb.Append(","); sb.Append("\"S\""); first = false; }
            if (s_keyD) { if (!first) sb.Append(","); sb.Append("\"D\""); first = false; }
            if (s_keyShift) { if (!first) sb.Append(","); sb.Append("\"Shift\""); first = false; }
            if (s_keyTurnLeft) { if (!first) sb.Append(","); sb.Append("\"TurnLeft\""); first = false; }
            if (s_keyTurnRight) { if (!first) sb.Append(","); sb.Append("\"TurnRight\""); first = false; }
            sb.Append("]");
            // 角色状态
            if (s_playerController != null)
            {
                var pos = s_playerController.transform.position;
                var fwd = s_playerController.transform.forward;
                sb.Append(",\"pos\":{").Append("\"x\":").Append(pos.x.ToString("F1")).Append(",\"y\":").Append(pos.y.ToString("F1")).Append(",\"z\":").Append(pos.z.ToString("F1")).Append("}");
                sb.Append(",\"forward\":{").Append("\"x\":").Append(fwd.x.ToString("F2")).Append(",\"z\":").Append(fwd.z.ToString("F2")).Append("}");
                var t = s_playerController.GetType();
                try { var p = t.GetProperty("IsGrounded"); if (p != null) sb.Append(",\"grounded\":").Append((bool)p.GetValue(s_playerController)); } catch { }
                try { var p = t.GetProperty("CurrentPlanarSpeed"); if (p != null) sb.Append(",\"speed\":").Append(((float)p.GetValue(s_playerController)).ToString("F1")); } catch { }
            }
            sb.Append(",\"takeover\":").Append(s_takeover ? "true" : "false");
            sb.Append("}");
            return sb.ToString();
        }

        // 检查按键是否超过最大持续时间，超时自动 release（防模型忘松手）
        private static void CheckKeyHoldTimeout()
        {
            double now = Time.realtimeSinceStartup;
            if (s_keyW && now - s_keyWTime > MAX_KEY_HOLD) s_keyW = false;
            if (s_keyA && now - s_keyATime > MAX_KEY_HOLD) s_keyA = false;
            if (s_keyS && now - s_keySTime > MAX_KEY_HOLD) s_keyS = false;
            if (s_keyD && now - s_keyDTime > MAX_KEY_HOLD) s_keyD = false;
            if (s_keyShift && now - s_keyShiftTime > MAX_KEY_HOLD) s_keyShift = false;
            if (s_keyTurnLeft && now - s_keyTurnLeftTime > MAX_KEY_HOLD) s_keyTurnLeft = false;
            if (s_keyTurnRight && now - s_keyTurnRightTime > MAX_KEY_HOLD) s_keyTurnRight = false;
        }

        // ─── 每帧驱动角色（LateUpdate，在游戏 Update 之后）──────────────
        // 游戏 PlayerController 已被禁用，AgentInput 独占 CharacterController.Move。
        private void LateUpdate()
        {
            // 按键超时兑底（防模型忘松手）
            CheckKeyHoldTimeout();

            // ── 合成虚拟输入：duration_ms 计时器优先，press/release 按键合成兑底 ──
            // 2026-07-31 重构：新范式用 Move/Turn duration_ms API，press/release 仅作兼容。
            // 计时器有效期间每帧维持目标值；超时则交由按键合成（无按键=zero）。
            double now = Time.realtimeSinceStartup;

            // 移动：duration 计时器优先
            if (s_moveEndTime > 0)
            {
                if (now < s_moveEndTime)
                {
                    s_virtualMove = s_moveTarget;  // 维持 Move 设的方向
                }
                else
                {
                    s_virtualMove = Vector2.zero;
                    s_moveEndTime = -1;
                }
            }
            else
            {
                // press/release 兑底（无 duration 计时器时）：W/S=前后(z)，A/D=左右(x)
                float mx = 0f, mz = 0f;
                if (s_keyD) mx += 1f;
                if (s_keyA) mx -= 1f;
                if (s_keyW) mz += 1f;
                if (s_keyS) mz -= 1f;
                s_virtualMove = new Vector2(mx, mz);
            }
            s_virtualSprint = s_keyShift;

            if (!s_takeover) return;
            if (!Application.isPlaying) return;

            // ── 转向（有游戏副作用，必须在 takeover 判定之后）──
            // duration 计时器优先。turn 语义 = 角色转身（相机跟随角色）。
            // 2026-07-31 v2：turn 改角色朝向而非相机 yaw，消除“相机朝向≠角色朝向”的方向错乱。
            // 模型看到的画面方向 = 角色朝向 = move_forward 方向，零错乱。
            // turn 计时器有效期间每帧给角色 yaw 加 s_turnPerFrameYaw；超时则停。
            s_virtualYawDelta = 0f;
            s_virtualPitchDelta = 0f;
            if (s_turnEndTime > 0)
            {
                if (now < s_turnEndTime && s_playerController != null)
                {
                    // 直接转角色朝向（不用 SmoothDampAngle——turn 要即时响应，平滑靠 duration 分摊）
                    float cur = s_playerController.transform.eulerAngles.y;
                    s_playerController.transform.rotation = Quaternion.Euler(0f, cur + s_turnPerFrameYaw, 0f);
                }
                else
                {
                    s_turnEndTime = -1;
                }
            }
            else
            {
                // press/release 兑底：TurnLeft/TurnRight 按住时转角色（与 duration 范式一致）
                float turnRate = 90f * Time.deltaTime;
                if (s_playerController != null && (s_keyTurnLeft || s_keyTurnRight))
                {
                    float cur = s_playerController.transform.eulerAngles.y;
                    if (s_keyTurnLeft) cur -= turnRate;
                    if (s_keyTurnRight) cur += turnRate;
                    s_playerController.transform.rotation = Quaternion.Euler(0f, cur, 0f);
                }
            }

            // 完全接管模式：每帧维持鼠标释放 + InputLock.UiOpen=true。
            // 游戏可能在某处重新 Cursor.lockState=Locked 抢走 OS 焦点，接管期间持续覆盖。
            // 共享模式（allowPlayerControl=true）不碋鼠标，玩家可正常操控。
            if (!s_allowPlayerControl)
            {
                if (Cursor.lockState != CursorLockMode.None)
                {
                    Cursor.lockState = CursorLockMode.None;
                    Cursor.visible = true;
                }
                TrySetInputLockUiOpen(true);
            }
            if (s_charController == null) return;

            float dt = Time.deltaTime;

            // 计算移动方向：虚拟输入相对角色朝向（W=角色前方）。
            // 2026-07-31 v2：turn 改角色朝向后，move 按角色朝向走——画面方向=角色朝向=move 方向，零错乱。
            // moveInput: x=Horizontal(左右), z=Vertical(前后, 1=前)
            Vector3 moveDir = Vector3.zero;
            bool hasInput = s_virtualMove.sqrMagnitude > 0.01f;
            if (hasInput)
            {
                // 移动方向相对角色当前朝向（W=角色前方，S=后方，A=左，D=右）。
                // turn 已转角色朝向，move 直接按角色朝向走，无需再 SmoothDampAngle 转身。
                float charYaw = s_playerController != null
                    ? s_playerController.transform.eulerAngles.y
                    : 0f;
                float targetAngle = Mathf.Atan2(s_virtualMove.x, s_virtualMove.y) * Mathf.Rad2Deg + charYaw;
                moveDir = Quaternion.Euler(0f, targetAngle, 0f) * Vector3.forward;
                moveDir = moveDir.normalized;
            }
            bool isSprinting = s_virtualSprint && hasInput;
            float speed = isSprinting ? s_runSpeed : s_walkSpeed;
            if (!hasInput) speed = 0f;

            // 自管重力（游戏 Update 被禁，重力不能丢）。用反射读的 gravity，默认 -20。
            if (s_charController.isGrounded && s_verticalVelocity < 0f)
                s_verticalVelocity = -2f;
            s_verticalVelocity += s_gravity * dt;

            Vector3 velocity = moveDir * speed + Vector3.up * s_verticalVelocity;
            s_charController.Move(velocity * dt);

            // ─── A+ 核心：反射设游戏控制器的状态字段，让 PlayerAnimator 读到正确值 ──
            // 游戏 PlayerController.Update 被禁用，CurrentPlanarSpeed/IsSprinting/IsGrounded
            // 不会被游戏自己更新。PlayerAnimator.Update 读这些属性驱动 Animator（SetFloat Speed,
            // SetBool IsGrounded）。这里反射设值，动画才能跑起来（行走/跑步动画 + 落地动画）。
            // 时序：PlayerAnimator 是普通 Update，先于 AgentInput 的 LateUpdate 跑——所以
            // PlayerAnimator 本帧读到的是上一帧 AgentInput 设的值，差一帧。SetFloat 有 dampTime
            // 平滑，单帧差不影响最终动画表现。
            if (s_playerController != null)
            {
                // 平面速度：直接用本帧计算的 speed（walkSpeed/runSpeed）。
                // 不用 CharacterController.velocity——它在 Move 当帧返回 0（Unity 内部
                // 要等物理更新才填充），会导致 PlayerAnimator 读到 Speed=0 无行走动画。
                // 用 speed 与游戏算法等价（游戏也是用目标速度驱动动画）。
                try { if (s_planarSpeedProp != null) s_planarSpeedProp.SetValue(s_playerController, speed); } catch { }
                try { if (s_isSprintingProp != null) s_isSprintingProp.SetValue(s_playerController, isSprinting); } catch { }
                try { if (s_isGroundedProp != null) s_isGroundedProp.SetValue(s_playerController, s_charController.isGrounded); } catch { }
            }

            // 相机跟随角色：yaw = 角色朝向，pitch 固定（接管时记录的值）。
            // 2026-07-31 v2：turn 转角色朝向，相机硬跟角色——画面方向=角色朝向，
            // 模型看到的“前方”就是 move_forward 的方向，消除方向错乱。
            if (s_followCamera != null && s_yawField != null && s_playerController != null)
            {
                try
                {
                    // 直接设 yaw=角色朝向（不用 SmoothDampAngle——速度变量可能失控致 yaw 累加到 1.8万）。
                    s_yawField.SetValue(s_followCamera, s_playerController.transform.eulerAngles.y);
                } catch { }
            }
            if (s_followCamera != null && s_pitchField != null)
            {
                try { s_pitchField.SetValue(s_followCamera, s_fixedPitch); } catch { }
            }

            // 跳跃/交互：旧 Input Manager 无法注入 GetKeyDown，仅清零标记。
            if (s_virtualJump) s_virtualJump = false;
            if (s_virtualInteract) s_virtualInteract = false;
        }
        private static float s_turnSmoothVelocity;

        // ─── 反射探测游戏结构（静态）────────────────────────────────────
        // 扫描场景，按命名约定找 PlayerController/CharacterController/相机/InputLock。
        // 用 static 字段存结果。Play 切换后 s_staleProbe 置位，下次调用强制重探。
        private static void ProbeStatic()
        {
            if (s_probed && !s_staleProbe) return;
            // 重探前先清掉可能已失效的旧引用（Play 切换后场景对象已销毁）
            s_playerController = null;
            s_playerControllerType = null;
            s_followCamera = null;
            s_charController = null;
            s_moveInputField = null;
            s_sprintField = null;
            s_yawField = null;
            s_pitchField = null;
            s_planarSpeedProp = null;
            s_isSprintingProp = null;
            s_isGroundedProp = null;
            s_probed = true;
            s_staleProbe = false;

            // 找 PlayerController：按类型名匹配（兼容不同命名空间）
            MonoBehaviour[] allMono;
            try { allMono = UnityEngine.Object.FindObjectsOfType<MonoBehaviour>(); }
            catch { return; }
            if (allMono == null) return;
            foreach (var mb in allMono)
            {
                try
                {
                    if (mb == null) continue;
                    var t = mb.GetType();

                    // ── 探测游戏控制器：优先按类型名，次按特征（放宽）──
                    // 特征：有 CharacterController 组件 + 有 Vector2 类型且名为
                    //   moveInput/move/input 的字段。这样不依赖类名叫 PlayerController。
                    if (s_playerController == null)
                    {
                        bool isController = false;
                        // 1) 先按类名匹配（标准项目）。仍要求有 CharacterController，避免误选同名脚本。
                        if ((t.Name == "PlayerController" || t.Name == "PlayerMovement")
                            && mb.GetComponent<CharacterController>() != null)
                            isController = true;
                        // 2) 按特征匹配：有 CharacterController + Vector2 输入字段
                        if (!isController)
                        {
                            var cc = mb.GetComponent<CharacterController>();
                            if (cc != null)
                            {
                                FieldInfo v2 = TryGetField(t, new[]{ "moveInput", "move", "input", "moveDir" });
                                if (v2 != null && v2.FieldType == typeof(Vector2))
                                    isController = true;
                            }
                        }
                        if (isController)
                        {
                            s_playerController = mb;
                            s_playerControllerType = t;
                            // 找 Vector2 输入字段（多常见名）——用于 Describe 报告
                            s_moveInputField = TryGetField(t, new[]{ "moveInput", "move", "input", "moveDir" });
                            // 找冲刺字段（多常见名）
                            s_sprintField = TryGetField(t, new[]{ "sprintHeld", "sprint", "isSprinting", "running" });
                            // 读速度参数（多常见名）
                            s_walkSpeed = ReadFloatField(t, mb, new[]{ "walkSpeed", "moveSpeed" }, 2.5f);
                            s_runSpeed = ReadFloatField(t, mb, new[]{ "runSpeed", "sprintSpeed" }, 6f);
                            s_turnSmoothTime = ReadFloatField(t, mb, new[]{ "turnSmoothTime", "rotationSmoothTime", "turnSmooth" }, 0.12f);
                            s_gravity = ReadFloatField(t, mb, new[]{ "gravity" }, -20f);
                            // 拿 CharacterController
                            s_charController = mb.GetComponent<CharacterController>();
                            // ── 探测状态属性的 setter（{ get; private set; } 要反射拿 SetMethod）──
                            // 这些属性被 PlayerAnimator 读以驱动动画。设它们让动画跑起来。
                            s_planarSpeedProp = TryGetSettableProp(t, new[]{ "CurrentPlanarSpeed", "Speed", "moveAmount", "velocity", "planarSpeed", "moveSpeed" }, typeof(float));
                            s_isSprintingProp = TryGetSettableProp(t, new[]{ "IsSprinting", "isSprinting", "Sprinting", "IsRunning" }, typeof(bool));
                            s_isGroundedProp = TryGetSettableProp(t, new[]{ "IsGrounded", "isGrounded", "Grounded" }, typeof(bool));
                        }
                    }

                    // 找 follow camera：有 yaw 字段（float）
                    if (s_followCamera == null)
                    {
                        var yawF = t.GetField("yaw", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
                        if (yawF != null && yawF.FieldType == typeof(float))
                        {
                            s_followCamera = mb;
                            s_yawField = yawF;
                            s_pitchField = t.GetField("pitch", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
                        }
                    }
                }
                catch { /* mb may be a destroyed Unity object; skip */ }
            }
            // 找 InputLock 静态类（所有已加载程序集）
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                try
                {
                    foreach (var t in asm.GetTypes())
                    {
                        if (t.Name == "InputLock" && t.IsClass && t.IsAbstract)
                        {
                            s_inputLockType = t;
                            s_inputLockUiOpenProp = t.GetProperty("UiOpen", BindingFlags.Public | BindingFlags.Static);
                            break;
                        }
                    }
                }
                catch { }
                if (s_inputLockType != null) break;
            }
        }

        // 按多个候选名找实例字段（public/private）。返回第一个命中的。
        private static FieldInfo TryGetField(Type t, string[] names)
        {
            foreach (var n in names)
            {
                try
                {
                    var f = t.GetField(n, BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
                    if (f != null) return f;
                } catch { }
            }
            return null;
        }

        // 按多个候选名找属性并要求其可写（拿 SetMethod）。{ get; private set; } 的
        // setter 反射拿到后可被 SetValue 调用。expectedType 为 null 表示不校验类型。
        private static PropertyInfo TryGetSettableProp(Type t, string[] names, Type expectedType)
        {
            foreach (var n in names)
            {
                try
                {
                    var p = t.GetProperty(n, BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
                    if (p == null) continue;
                    if (expectedType != null && p.PropertyType != expectedType) continue;
                    var setter = p.GetSetMethod(true);  // nonPublic=true，能拿 private set
                    if (setter != null) return p;
                } catch { }
            }
            return null;
        }

        // 多候选名版本：读 float 字段，第一个命中返回其值，否则 defaultVal。
        private static float ReadFloatField(Type t, object obj, string[] names, float defaultVal)
        {
            foreach (var n in names)
            {
                try
                {
                    var f = t.GetField(n, BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
                    if (f != null && f.FieldType == typeof(float))
                        return (float)f.GetValue(obj);
                } catch { }
            }
            return defaultVal;
        }

        /// <summary>反射读 InputLock.UiOpen 当前值（探测不到时返回 false）。</summary>
        private static bool GetInputLockUiOpen()
        {
            if (s_inputLockType == null) return false;
            try
            {
                if (s_inputLockUiOpenProp != null && s_inputLockUiOpenProp.CanRead)
                    return (bool)s_inputLockUiOpenProp.GetValue(null);
            }
            catch { /* best-effort */ }
            return false;
        }

        /// <summary>
        /// 反射设 InputLock.UiOpen=true（若探测到该静态类）。
        /// 双保险：让游戏自己的输入逻辑走 UI 分支（不读 Input、不锁鼠标）。
        /// 幂等，每帧调用安全。
        /// </summary>
        private static void TrySetInputLockUiOpen(bool open)
        {
            if (s_inputLockType == null) return;
            try
            {
                // 优先调 SetUiOpen(bool) 方法（游戏的标准入口，会一并处理 Cursor）
                var m = s_inputLockType.GetMethod("SetUiOpen", BindingFlags.Public | BindingFlags.Static);
                if (m != null) { m.Invoke(null, new object[] { open }); return; }
                // 退而求其次：直接设 UiOpen 属性
                if (s_inputLockUiOpenProp != null && s_inputLockUiOpenProp.CanWrite)
                    s_inputLockUiOpenProp.SetValue(null, open);
            }
            catch { /* best-effort */ }
        }

        /// <summary>
        /// 释放鼠标：探测 InputLock 并设 UiOpen=true（会一并解锁 Cursor），
        /// 同时直接 Cursor.lockState=None 双保险。幂等。
        /// 注意：只应在 agent 接管（TakeOver）期间调用——它会停掉游戏的输入逻辑，
        /// 绝不能挂在 Play Mode 进入钩子上（那会破坏用户手动 Play 的操控）。
        /// </summary>
        public static void ReleaseMouse()
        {
            // 先探测 InputLock（静态类，不依赖场景对象，任何时候都能找）
            if (s_inputLockType == null)
            {
                foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
                {
                    try
                    {
                        foreach (var t in asm.GetTypes())
                        {
                            if (t.Name == "InputLock" && t.IsClass && t.IsAbstract)
                            {
                                s_inputLockType = t;
                                s_inputLockUiOpenProp = t.GetProperty("UiOpen", BindingFlags.Public | BindingFlags.Static);
                                break;
                            }
                        }
                    } catch { }
                    if (s_inputLockType != null) break;
                }
            }
            TrySetInputLockUiOpen(true);
            // 双保险：即使没有 InputLock，也直接解锁 Cursor
            Cursor.lockState = CursorLockMode.None;
            Cursor.visible = true;
        }
        private static string PromptFilePath => System.IO.Path.Combine(
            UnityEngine.Application.dataPath, "Scripts", "AgentInput", "AgentPrompt.txt");
        // ─── 决策 prompt 模板（项目可自定义）──────────────────────────
        // prompt 存同目录 AgentPrompt.txt（install 时复制，已存在不覆盖，保留项目自定义）。
        // vision agent 每步决策调 GetDecisionPrompt() 取回，拼接 taskGoal/历史/帧描述。
        // 项目可直接编辑 AgentPrompt.txt，或调 SetDecisionPrompt，改了无需 reload pi 扩展。
        private static string s_decisionPrompt;

        // 不缓存：每次读文件，这样项目编辑 AgentPrompt.txt 立即生效，无需 domain reload。
        // 文件读取很快，每步一次无妨。
        public static string GetDecisionPrompt()
        {
            try { return System.IO.File.ReadAllText(PromptFilePath); }
            catch { return "当前画面见附图。决定下一步动作。"; }
        }

        public static string SetDecisionPrompt(string prompt)
        {
            s_decisionPrompt = string.IsNullOrEmpty(prompt) ? null : prompt;
            try { System.IO.File.WriteAllText(PromptFilePath, s_decisionPrompt ?? ""); }
            catch { }
            return "decision prompt saved to " + PromptFilePath + " (" + (s_decisionPrompt?.Length ?? 0) + " chars)";
        }

        // Play Mode 进入时场景对象重建，探测缓存由下次 ProbeStatic 经 s_staleProbe 重建。
        // 这里不碰鼠标/InputLock——用户手动点 Play 时游戏必须保持原样（UiOpen=false、
        // 鼠标由游戏自己管），任何自动释放都会破坏操控。
        private void OnEnable()
        {
            ResetProbe();
        }

        // 重置探测结果并标记重探（Play 切换后场景对象已失效）。同时清 takeover/虚拟输入/
        // 计时器/按键状态——Play 会话结束或单例重建后不该残留任何接管痕迹。
        private static void ResetProbe()
        {
            s_probed = false;
            s_staleProbe = true;
            s_takeover = false;
            s_allowPlayerControl = false;
            s_virtualMove = Vector2.zero;
            s_moveTarget = Vector2.zero;
            s_virtualSprint = false;
            s_virtualYawDelta = 0f;
            s_virtualPitchDelta = 0f;
            s_moveEndTime = -1;
            s_turnEndTime = -1;
            s_keyW = s_keyA = s_keyS = s_keyD = false;
            s_keyShift = false;
            s_keyTurnLeft = s_keyTurnRight = false;
            s_playerController = null;
            s_playerControllerType = null;
            s_followCamera = null;
            s_charController = null;
            s_moveInputField = null;
            s_sprintField = null;
            s_yawField = null;
            s_pitchField = null;
            s_planarSpeedProp = null;
            s_isSprintingProp = null;
            s_isGroundedProp = null;
            s_walkSpeed = 2.5f;
            s_runSpeed = 6f;
            s_turnSmoothTime = 0.12f;
            s_gravity = -20f;
            s_turnSmoothVelocity = 0f;
        }
    }
}
#endif
