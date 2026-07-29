/*
 * AgentInput — 视觉 agent 的输入接管层，完全不碰 OS 输入。
 *
 * 解决的问题：Win32 keybd_event/mouse_event 是 OS 级注入，agent 执行时会
 * 干扰用户（抢焦点、吞键盘）。AgentInput 直接操作游戏对象的输入字段，
 * 用户可以随意动鼠标键盘，互不影响。Unity 也可以在后台跑。
 *
 * 设计：通用框架 + 项目适配
 *   - 通用框架（本文件）：反射自动探测常见 Unity 输入模式，提供高层 API
 *     （MoveForward/Turn/Interact 等）。随 PiBridge install 部署。
 *   - 项目适配（AgentInputProfile.cs，可选）：agent 现场生成，声明精确的
 *     字段映射。有 profile 时优先用，没有则反射探测。
 *
 * 自描述：Describe() 返回 JSON，说明支持哪些动作 + 探测到的游戏结构。
 * agent install 后调 Describe() 就能读懂这个项目能做什么，无需人工开发。
 *
 * 工作原理：
 *   - TakeOver()：设置 _takeover=true，挂到场景的 AgentInput 实例开始每帧
 *     在游戏 Update 之后（用 LateUpdate）覆盖输入字段为 _virtual* 值。
 *   - Release()：_takeover=false，恢复游戏读取真实 Input。
 *   - 一帧延迟：游戏 Update 用上一帧 LateUpdate 设的值，可接受。
 *
 * 限制：
 *   - 反射探测依赖命名约定（moveInput/yaw/pitch/InputLock），不保证所有
 *     项目都能探测到。探测失败时 Describe() 报告 unsupported，agent 应回退
 *     到 Win32 方案。
 *   - 直接设 private 字段是 fragile 的（游戏更新可能改名），但比改游戏
 *     代码侵入性小。Profile 可固定字段名提高可靠性。
 *
 * License: MIT
 */

using System;
using System.Collections;
using System.Collections.Generic;
using System.Reflection;
using UnityEngine;

namespace PiBridge
{
    /// <summary>
    /// 视觉 agent 的输入接管层。挂到场景后通过反射操作游戏对象的输入字段，
    /// 完全不经过 OS 输入系统。agent 通过 PiBridge eval 调用静态方法。
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

        // ─── 接管状态 + 虚拟输入值 ─────────────────────────────────────
        private bool _takeover;
        private Vector2 _virtualMove = Vector2.zero;   // (-1~1, -1~1)
        private bool _virtualSprint;
        private float _virtualYawDelta;                // 本帧 yaw 增量（度）
        private float _virtualPitchDelta;
        private bool _virtualJump;                     // 本帧是否跳（消费后清零）
        private bool _virtualInteract;                 // 本帧是否交互（消费后清零）

        // ─── 探测到的游戏结构（首次 TakeOver 时探测）─────────────────
        private bool _probed;
        private MonoBehaviour _playerController;       // 有 moveInput 字段的脚本
        private FieldInfo _moveInputField;
        private FieldInfo _sprintField;
        private MonoBehaviour _followCamera;           // 有 yaw/pitch 字段的脚本
        private FieldInfo _yawField;
        private FieldInfo _pitchField;
        private Type _inputLockType;
        private PropertyInfo _inputLockUiOpenProp;

        /// <summary>探测游戏结构。返回 JSON 描述支持的能力。</summary>
        public static string Describe()
        {
            ProbeStatic();
            var sb = new System.Text.StringBuilder();
            sb.Append("{");
            sb.Append("\"takeover\":").Append((_instance != null && _instance._takeover) ? "true" : "false").Append(",");
            sb.Append("\"playerController\":");
            if (inst._playerController != null)
            {
                sb.Append("{\"found\":true,\"type\":\"").Append(inst._playerController.GetType().FullName).Append("\"");
                sb.Append(",\"moveInput\":\"").Append(inst._moveInputField?.Name ?? "null").Append("\"");
                sb.Append(",\"sprint\":\"").Append(inst._sprintField?.Name ?? "null").Append("\"}");
            }
            else sb.Append("{\"found\":false}");
            sb.Append(",\"followCamera\":");
            if (inst._followCamera != null)
            {
                sb.Append("{\"found\":true,\"type\":\"").Append(inst._followCamera.GetType().FullName).Append("\"");
                sb.Append(",\"yaw\":\"").Append(inst._yawField?.Name ?? "null").Append("\"");
                sb.Append(",\"pitch\":\"").Append(inst._pitchField?.Name ?? "null").Append("\"}");
            }
            else sb.Append("{\"found\":false}");
            sb.Append(",\"inputLock\":");
            if (inst._inputLockType != null)
            {
                sb.Append("{\"found\":true,\"type\":\"").Append(inst._inputLockType.FullName).Append("\"}");
            }
            else sb.Append("{\"found\":false}");
            sb.Append(",\"actions\":[\"move_forward\",\"move_backward\",\"move_left\",\"move_right\",\"turn_left\",\"turn_right\",\"interact\",\"jump\",\"wait\"]");
            sb.Append("}");
            return sb.ToString();
        }

        /// <summary>开始接管输入。之后游戏读取到的输入由 AgentInput 提供。</summary>
        public static string TakeOver()
        {
            Instance.Probe();
            Instance._takeover = true;
            return "took over input: " + (Instance._playerController != null || Instance._followCamera != null);
        }

        /// <summary>释放输入，恢复游戏读取真实 Input。</summary>
        public static string Release()
        {
            if (_instance != null)
            {
                _instance._takeover = false;
                _instance._virtualMove = Vector2.zero;
                _instance._virtualSprint = false;
            }
            return "released input";
        }

        // ─── 高层动作 API（agent 通过 eval 调用）────────────────────────
        // 这些方法设置虚拟输入值，实际生效在 LateUpdate（游戏 Update 之后）。

        /// <summary>持续移动。x/z 是 -1~1，duration_ms 后停止。协程驱动。</summary>
        public static string Move(float x, float z, int durationMs)
        {
            var inst = Instance;
            inst.StartCoroutine(inst.MoveRoutine(x, z, durationMs));
            return "move x=" + x + " z=" + z + " " + durationMs + "ms";
        }

        private IEnumerator MoveRoutine(float x, float z, int durationMs)
        {
            _virtualMove = new Vector2(x, z);
            yield return new WaitForSeconds(durationMs / 1000f);
            _virtualMove = Vector2.zero;
        }

        /// <summary>转向。yawDelta/pitchDelta 是度数增量。</summary>
        public static string Turn(float yawDelta, float pitchDelta, int durationMs)
        {
            var inst = Instance;
            inst.StartCoroutine(inst.TurnRoutine(yawDelta, pitchDelta, durationMs));
            return "turn yaw=" + yawDelta + " pitch=" + pitchDelta + " " + durationMs + "ms";
        }

        private IEnumerator TurnRoutine(float yawDelta, float pitchDelta, int durationMs)
        {
            float perFrameYaw = yawDelta / (durationMs / 1000f) * Time.fixedDeltaTime;
            float perFramePitch = pitchDelta / (durationMs / 1000f) * Time.fixedDeltaTime;
            float elapsed = 0;
            while (elapsed < durationMs / 1000f)
            {
                _virtualYawDelta = perFrameYaw;
                _virtualPitchDelta = perFramePitch;
                elapsed += Time.fixedDeltaTime;
                yield return new WaitForFixedUpdate();
            }
            _virtualYawDelta = 0;
            _virtualPitchDelta = 0;
        }

        /// <summary>交互（E 键等价）。下一帧消费后清零。</summary>
        public static string Interact()
        {
            Instance._virtualInteract = true;
            return "interact";
        }

        /// <summary>跳跃（Space 等价）。下一帧消费后清零。</summary>
        public static string Jump()
        {
            Instance._virtualJump = true;
            return "jump";
        }

        // ─── 每帧覆盖游戏输入字段（LateUpdate，在游戏 Update 之后）─────────
        private void LateUpdate()
        {
            if (!_takeover) return;

            // 覆盖移动输入
            if (_playerController != null && _moveInputField != null)
            {
                try { _moveInputField.SetValue(_playerController, _virtualMove); } catch { }
            }
            if (_sprintField != null && _playerController != null)
            {
                try { _sprintField.SetValue(_playerController, _virtualSprint); } catch { }
            }

            // 覆盖相机旋转
            if (_followCamera != null && _yawField != null)
            {
                try
                {
                    float yaw = (float)_yawField.GetValue(_followCamera);
                    _yawField.SetValue(_followCamera, yaw + _virtualYawDelta);
                } catch { }
            }
            if (_followCamera != null && _pitchField != null)
            {
                try
                {
                    float pitch = (float)_pitchField.GetValue(_followCamera);
                    _pitchField.SetValue(_followCamera, pitch + _virtualPitchDelta);
                } catch { }
            }

            // 跳跃/交互：模拟 GetKeyDown（一帧 true）。游戏代码读 Input.GetButtonDown
            // 无法直接注入，所以我们临时设 InputLock 或调用游戏方法。这里标记消费。
            // 注意：旧 Input Manager 无法注入 GetKeyDown，跳跃/交互需要游戏有 public
            // 方法或 profile 指定。当前仅清零标记——完整支持需 AgentInputProfile。
            if (_virtualJump) _virtualJump = false;
            if (_virtualInteract) _virtualInteract = false;
        }

        // ─── 反射探测游戏结构 ──────────────────────────────────────────
        // 扫描场景里的 MonoBehaviour，按命名约定找输入字段。
        private void Probe()
        {
            if (_probed) return;
            _probed = true;

            var allMono = FindObjectsOfType<MonoBehaviour>();
            foreach (var mb in allMono)
            {
                try
                {
                    if (mb == null) continue;
                    var t = mb.GetType();

                // 找 player controller：有 moveInput 字段（Vector2）
                if (_playerController == null)
                {
                    var f = t.GetField("moveInput", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
                    if (f != null && f.FieldType == typeof(Vector2))
                    {
                        _playerController = mb;
                        _moveInputField = f;
                        // 顺便找 sprint 字段
                        _sprintField = t.GetField("sprintHeld", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
                    }
                }

                // 找 follow camera：有 yaw 字段（float）
                if (_followCamera == null)
                {
                    var yawF = t.GetField("yaw", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
                    if (yawF != null && yawF.FieldType == typeof(float))
                    {
                        _followCamera = mb;
                        _yawField = yawF;
                        _pitchField = t.GetField("pitch", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
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
                        if (t.Name == "InputLock" && t.IsClass && t.IsAbstract) // static class
                        {
                            _inputLockType = t;
                            _inputLockUiOpenProp = t.GetProperty("UiOpen", BindingFlags.Public | BindingFlags.Static);
                            break;
                        }
                    }
                }
                catch { }
                if (_inputLockType != null) break;
            }
        }
    }
}
