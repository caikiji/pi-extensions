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
 * ─── 接管策略 ──────────────────────────────────────────────────────
 * 旧 Input Manager（CourseProject 用的）无法注入 Input.GetAxisRaw，而游戏
 * PlayerController.Update 每帧用 Input 覆盖 moveInput 字段——所以覆盖字段
 * 走不通（无论什么时机都会被冲掉）。
 *
 * 改用"禁用游戏控制器 + 自己驱动 CharacterController"：
 *   - TakeOver()：反射找到 PlayerController，设 enabled=false（游戏 Update
 *     不再跑，不读 Input、不移动），反射拿它身上的 CharacterController。
 *   - LateUpdate()：AgentInput 自己每帧 CharacterController.Move，方向由
 *     s_virtualMove + 相机朝向算出，速度取 walkSpeed/runSpeed，重力自管。
 *   - Release()：PlayerController.enabled=true，游戏恢复控制。
 *
 * 这样完全绕过游戏的输入层，不依赖覆盖字段的时序，也不和游戏 Update 冲突。
 *
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
                        _instance = go.AddComponent<AgentInput>();
                        if (Application.isPlaying) DontDestroyOnLoad(go);
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

        // ─── 持续动作计时器（替代协程）────────────────────────────────
        private static double s_moveEndTime = -1;   // EditorApplication.timeSinceStartup
        private static double s_turnEndTime = -1;
        private static float s_turnPerFrameYaw;
        private static float s_turnPerFramePitch;

        // ─── 探测到的游戏结构（static，Describe/TakeOver/LateUpdate 共享）─
        private static bool s_probed;
        private static MonoBehaviour s_playerController;       // 游戏的 PlayerController
        private static Type s_playerControllerType;
        private static FieldInfo s_moveInputField;
        private static FieldInfo s_sprintField;
        private static CharacterController s_charController;   // PlayerController 身上的
        private static float s_walkSpeed;
        private static float s_runSpeed;
        private static MonoBehaviour s_followCamera;           // 有 yaw/pitch 字段的脚本
        private static FieldInfo s_yawField;
        private static FieldInfo s_pitchField;
        private static Type s_inputLockType;
        private static PropertyInfo s_inputLockUiOpenProp;
        private static bool s_playerWasEnabled;                // TakeOver 前的 enabled，Release 恢复

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
                sb.Append(",\"runSpeed\":").Append(s_runSpeed).Append("}");
            }
            else sb.Append("{\"found\":false}");
            sb.Append(",\"followCamera\":");
            if (s_followCamera != null)
            {
                sb.Append("{\"found\":true,\"type\":\"").Append(s_followCamera.GetType().FullName).Append("\"");
                sb.Append(",\"yaw\":\"").Append(s_yawField?.Name ?? "null").Append("\"");
                sb.Append(",\"pitch\":\"").Append(s_pitchField?.Name ?? "null").Append("\"}");
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
            ProbeStatic();
            var inst = Instance;
            s_takeover = true;
            s_allowPlayerControl = allowPlayerControl;
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
                TrySetInputLockUiOpen(true);
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
            s_virtualSprint = false;
            s_virtualYawDelta = 0;
            s_virtualPitchDelta = 0;
            s_moveEndTime = -1;
            s_turnEndTime = -1;
            if (s_playerController != null)
            {
                try { s_playerController.enabled = s_playerWasEnabled; } catch { }
            }
            return "released input";
        }

        // ─── 高层动作 API（agent 通过 eval 调用）────────────────────────

        /// <summary>持续移动。x/z 是 -1~1，duration_ms 后停止。</summary>
        public static string Move(float x, float z, int durationMs)
        {
            ProbeStatic();
            s_virtualMove = new Vector2(x, z);
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

        // ─── 每帧驱动角色（LateUpdate，在游戏 Update 之后）──────────────
        // 游戏 PlayerController 已被禁用，AgentInput 独占 CharacterController.Move。
        private void LateUpdate()
        {
            // 处理持续动作到期
            if (s_moveEndTime > 0 && Time.realtimeSinceStartup >= s_moveEndTime)
            {
                s_virtualMove = Vector2.zero;
                s_moveEndTime = -1;
            }
            if (s_turnEndTime > 0)
            {
                if (Time.realtimeSinceStartup < s_turnEndTime)
                {
                    s_virtualYawDelta = s_turnPerFrameYaw;
                    s_virtualPitchDelta = s_turnPerFramePitch;
                }
                else
                {
                    s_virtualYawDelta = 0;
                    s_virtualPitchDelta = 0;
                    s_turnEndTime = -1;
                }
            }

            if (!s_takeover) return;
            if (!Application.isPlaying) return;

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

            // 计算移动方向：虚拟输入 + 相机朝向
            Vector3 moveDir = Vector3.zero;
            if (s_virtualMove.sqrMagnitude > 0.01f)
            {
                // moveInput: x=Horizontal(左右), z=Vertical(前后, 1=前)
                // 相机朝向：取 Camera.main 的 yaw，让移动相对相机
                float camYaw = 0f;
                Camera cam = Camera.main;
                if (cam != null) camYaw = cam.transform.eulerAngles.y;
                float targetAngle = Mathf.Atan2(s_virtualMove.x, s_virtualMove.y) * Mathf.Rad2Deg + camYaw;
                moveDir = Quaternion.Euler(0f, targetAngle, 0f) * Vector3.forward;
                moveDir = moveDir.normalized;

                // 转向角色面向移动方向（平滑）
                if (s_playerController != null)
                {
                    float smoothYaw = Mathf.SmoothDampAngle(
                        s_playerController.transform.eulerAngles.y, targetAngle,
                        ref s_turnSmoothVelocity, 0.12f);
                    s_playerController.transform.rotation = Quaternion.Euler(0f, smoothYaw, 0f);
                }
            }
            float speed = s_virtualSprint ? s_runSpeed : s_walkSpeed;
            if (s_virtualMove.sqrMagnitude < 0.01f) speed = 0f;

            // 自管重力（游戏 Update 被禁，重力不能丢）
            if (s_charController.isGrounded && s_verticalVelocity < 0f)
                s_verticalVelocity = -2f;
            s_verticalVelocity += -20f * dt;  // 用默认重力 -20，理想情况从游戏反射读

            Vector3 velocity = moveDir * speed + Vector3.up * s_verticalVelocity;
            s_charController.Move(velocity * dt);

            // 相机旋转覆盖（如果有 followCamera 的 yaw/pitch 字段）
            if (s_followCamera != null && s_yawField != null)
            {
                try
                {
                    float yaw = (float)s_yawField.GetValue(s_followCamera);
                    s_yawField.SetValue(s_followCamera, yaw + s_virtualYawDelta);
                } catch { }
            }
            if (s_followCamera != null && s_pitchField != null)
            {
                try
                {
                    float pitch = (float)s_pitchField.GetValue(s_followCamera);
                    s_pitchField.SetValue(s_followCamera, pitch + s_virtualPitchDelta);
                } catch { }
            }

            // 跳跃/交互：旧 Input Manager 无法注入 GetKeyDown，仅清零标记。
            if (s_virtualJump) s_virtualJump = false;
            if (s_virtualInteract) s_virtualInteract = false;
        }
        private static float s_turnSmoothVelocity;

        // ─── 反射探测游戏结构（静态）────────────────────────────────────
        // 扫描场景，按命名约定找 PlayerController/CharacterController/相机/InputLock。
        // 用 static 字段存结果。Play Mode 进入时实例会重新探测（见 OnEnable）。
        private static void ProbeStatic()
        {
            if (s_probed) return;
            s_probed = true;

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

                    if (s_playerController == null && t.Name == "PlayerController")
                    {
                        s_playerController = mb;
                        s_playerControllerType = t;
                        // 找 moveInput 字段（Vector2）——用于 Describe 报告，不用于覆盖
                        s_moveInputField = t.GetField("moveInput", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
                        s_sprintField = t.GetField("sprintHeld", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
                        // 读速度参数
                        s_walkSpeed = ReadFloatField(t, mb, "walkSpeed", 2.5f);
                        s_runSpeed = ReadFloatField(t, mb, "runSpeed", 6f);
                        // 拿 CharacterController（PlayerController 身上 RequireComponent）
                        s_charController = mb.GetComponent<CharacterController>();
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

        private static float ReadFloatField(Type t, object obj, string fieldName, float defaultVal)
        {
            try
            {
                var f = t.GetField(fieldName, BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
                if (f != null && f.FieldType == typeof(float))
                    return (float)f.GetValue(obj);
            } catch { }
            return defaultVal;
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

        // Play Mode 进入时场景对象重建，重新探测。单例 OnEnable 时重置。
        private void OnEnable()
        {
            s_probed = false;
            s_playerController = null;
            s_followCamera = null;
            s_charController = null;
            s_moveInputField = null;
            s_sprintField = null;
            s_yawField = null;
            s_pitchField = null;
        }
    }
}
#endif
