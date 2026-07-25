/*
 * PiBridge.cs — HTTP bridge for controlling a running Unity Editor from outside.
 *
 * Place this file in Assets/Editor/ (any Editor folder). It auto-starts on
 * project load via [InitializeOnLoad]. Listens on 127.0.0.1 and exposes a
 * small command API so external tools (like the pi unity extension) can drive
 * the already-open Editor instance without launching a second Unity process.
 *
 * Architecture:
 *   - Background thread runs HttpListener (receives commands instantly,
 *     unaffected by Editor focus throttling)
 *   - Commands are dispatched to the main thread via EditorApplication.delayCall
 *     (Unity APIs are main-thread-only)
 *   - Results returned as JSON in the HTTP response
 *
 * Port discovery:
 *   - Tries 17841, 17842, ... until one is free
 *   - Writes the chosen port to Temp/pi-bridge-port for external discovery
 *
 * Security:
 *   - Listens on 127.0.0.1 ONLY (no LAN exposure)
 *   - Command whitelist (no arbitrary code by default; eval is opt-in via PI_BRIDGE_ALLOW_EVAL)
 *
 * Compatibility: Unity 2019.4 LTS and later.
 *
 * License: MIT
 */

using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using UnityEditor;
using UnityEditorInternal;
using UnityEngine;

namespace PiBridge
{
    [InitializeOnLoad]
    public static class Bridge
    {
        private const int DefaultPort = 17841;
        private const int MaxPortAttempts = 20;
        private const string PortFileName = "pi-bridge-port";
        private const string BridgeVersion = "0.2.2";

        // When true (default), the bridge brings Unity to the foreground before
        // dispatching a command, to bypass the ~1Hz delayCall throttle that
        // applies when the Editor is unfocused. Disable via the 'config' command
        // if you don't want the window stealing focus.
        private static bool AutoFocusEnabled = true;

        private static HttpListener _listener;
        private static Thread _thread;
        private static int _port;
        private static readonly object _lock = new object();

        static Bridge()
        {
            // Defer start to avoid blocking initialization; also re-start on
            // domain reload (after recompilation) which recreates statics.
            EditorApplication.delayCall += Start;
        }

        private static void Start()
        {
            lock (_lock)
            {
                if (_listener != null) return; // already running

                _port = FindFreePort();
                if (_port < 0)
                {
                    Debug.LogError("[PiBridge] Could not find a free port in range " +
                                   DefaultPort + "-" + (DefaultPort + MaxPortAttempts - 1));
                    return;
                }

                _listener = new HttpListener();
                _listener.Prefixes.Add("http://127.0.0.1:" + _port + "/");
                try
                {
                    _listener.Start();
                }
                catch (Exception e)
                {
                    Debug.LogError("[PiBridge] Failed to start listener: " + e.Message);
                    _listener = null;
                    return;
                }

                WritePortFile(_port);

                _thread = new Thread(RunServer) { IsBackground = true, Name = "PiBridge" };
                _thread.Start();

                Debug.Log("[PiBridge] Listening on http://127.0.0.1:" + _port +
                          " (version " + BridgeVersion + ")");
            }
        }

        private static int FindFreePort()
        {
            for (int p = DefaultPort; p < DefaultPort + MaxPortAttempts; p++)
            {
                try
                {
                    using (var l = new HttpListener())
                    {
                        l.Prefixes.Add("http://127.0.0.1:" + p + "/");
                        l.Start();
                        l.Stop();
                        return p;
                    }
                }
                catch
                {
                    // port in use or blocked; try next
                }
            }
            return -1;
        }

        private static void WritePortFile(int port)
        {
            try
            {
                var path = Path.Combine(Application.dataPath, "..", "Temp", PortFileName);
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                File.WriteAllText(path, port.ToString());
            }
            catch (Exception e)
            {
                Debug.LogWarning("[PiBridge] Could not write port file: " + e.Message);
            }
        }

        private static void RunServer()
        {
            while (_listener != null && _listener.IsListening)
            {
                try
                {
                    var context = _listener.GetContext();
                    ThreadPool.QueueUserWorkItem(_ => HandleRequest(context));
                }
                catch (HttpListenerException)
                {
                    // listener stopped
                    break;
                }
                catch (Exception e)
                {
                    Debug.LogError("[PiBridge] Accept error: " + e.Message);
                }
            }
        }

        private static void HandleRequest(HttpListenerContext context)
        {
            var startMs = DateTime.UtcNow.Ticks / TimeSpan.TicksPerMillisecond;
            var request = context.Request;
            var response = context.Response;

            try
            {
                // Parse command from URL path: /command
                string path = request.Url.AbsolutePath.TrimStart('/');
                if (string.IsNullOrEmpty(path))
                {
                    WriteJson(response, new { ok = false, error = "No command. GET /ping to check health." });
                    return;
                }

                // Read body (args)
                string body = "";
                if (request.HasEntityBody)
                {
                    using (var reader = new StreamReader(request.InputStream, request.ContentEncoding))
                        body = reader.ReadToEnd();
                }

                // Dispatch to main thread and wait for result.
                // run-menu uses a shorter timeout because ExecuteMenuItem can block
                // on a modal dialog and freeze the main thread.
                int dispatchTimeout = path.Equals("run-menu", StringComparison.OrdinalIgnoreCase) ? 15 : 120;
                var result = DispatchToMainThread(path, body, dispatchTimeout);
                result.durationMs = (int)((DateTime.UtcNow.Ticks / TimeSpan.TicksPerMillisecond) - startMs);

                WriteJson(response, result);
            }
            catch (Exception e)
            {
                try
                {
                    WriteJson(response, new { ok = false, error = e.Message, durationMs = 0 });
                }
                catch { }
            }
            finally
            {
                response.Close();
            }
        }

        // Dispatch a command to the main thread and block until it completes.
        // Uses delayCall; the calling (background) thread waits on a signal.
        //
        // BACKGROUND FOCUS WORKAROUND: Unity throttles EditorApplication.update
        // and delayCall to ~1Hz when the Editor window loses focus. To avoid
        // multi-second stalls, we bring Unity to the foreground before queueing
        // delayCall when the Editor is unfocused. This is the same approach used
        // by other Unity MCP bridges (e.g. unity-mcp-sharp). Controlled by the
        // autoFocus setting (default on); Linux/macOS skip the Win32 call.
        //
        // timeoutSeconds caps the wait. NOTE: if the main thread is blocked by a
        // modal dialog (e.g. from ExecuteMenuItem), the HTTP response may not be
        // deliverable even after this timeout fires — Unity's HttpListener
        // response flush can stall when the main thread is frozen. The reliable
        // protection is the client-side timeout in unity-command.ts, which
        // aborts the fetch and returns a clear error to the AI.
        private static Response DispatchToMainThread(string command, string body, int timeoutSeconds = 120)
        {
            // Bring Unity to the foreground BEFORE queuing the delayCall.
            // delayCall is itself throttled when Unity is unfocused (~1Hz), so if we
            // focused from inside the callback we'd be stuck waiting for the very
            // throttle we're trying to defeat. The HTTP thread is not throttled, so
            // focusing here is immediate; by the time the delayCall callback runs,
            // Unity is already in the foreground and executes at full speed.
            // This is unconditional: if Unity is already focused, SetForegroundWindow
            // is a harmless no-op. (AutoFocus can be disabled via the config command.)
            if (AutoFocusEnabled)
                FocusUnity(80); // ms to let the OS complete the foreground switch

            var done = new ManualResetEventSlim(false);
            Response response = null;

            EditorApplication.delayCall += () =>
            {
                // Fallback: re-check focus on the main thread (the authoritative
                // source via InternalEditorUtility). Covers the race where the
                // background-thread focus didn't take (e.g. foreground lock held).
                if (AutoFocusEnabled && !InternalEditorUtility.isApplicationActive)
                    FocusUnity(30);

                try
                {
                    response = ExecuteCommand(command, body);
                }
                catch (Exception e)
                {
                    response = new Response { ok = false, error = e.Message + "\n" + e.StackTrace };
                }
                finally
                {
                    done.Set();
                }
            };

            // Wait for main thread to process.
            if (!done.Wait(TimeSpan.FromSeconds(timeoutSeconds)))
            {
                return new Response { ok = false, error = $"Timed out waiting for main thread after {timeoutSeconds}s (Editor may be busy, unfocused, or blocked by a modal dialog)." };
            }

            return response ?? new Response { ok = false, error = "No response from main thread." };
        }

        // Bring Unity to the foreground (best-effort) and pause briefly so the OS
        // completes the foreground switch before the caller proceeds. The settleMs
        // delay lets a subsequent delayCall tick / focus re-check observe Unity as
        // active instead of racing the window raise.
        private static void FocusUnity(int settleMs)
        {
            try { WindowFocus.BringUnityToFront(); }
            catch { /* focus manipulation is best-effort; never fail a command */ }
            if (settleMs > 0) System.Threading.Thread.Sleep(settleMs);
        }

        private static Response ExecuteCommand(string command, string body)
        {
            var args = ParseArgs(body);

            switch (command.ToLowerInvariant())
            {
                case "ping":
                {
                    bool appActive = InternalEditorUtility.isApplicationActive;
                    return new Response
                    {
                        ok = true,
                        result = new
                        {
                            version = BridgeVersion,
                            unityVersion = Application.unityVersion,
                            projectPath = Application.dataPath.Replace("/Assets", "").Replace("\\Assets", ""),
                            applicationPath = EditorApplication.applicationPath,
                            autoFocus = AutoFocusEnabled,
                            isApplicationActive = appActive,
                        }
                    };
                }

                case "config":
                {
                    // Query or change bridge settings. Currently supports autoFocus.
                    //   { }                          -> return current config
                    //   { autoFocus: false }         -> disable auto-focus
                    if (args != null && args.TryGetValue("autoFocus", out object afValue))
                    {
                        AutoFocusEnabled = afValue is bool b ? b : Convert.ToBoolean(afValue);
                    }
                    return new Response
                    {
                        ok = true,
                        result = new { autoFocus = AutoFocusEnabled }
                    };
                }

                case "refresh":
                    AssetDatabase.Refresh();
                    return new Response { ok = true, result = new { refreshed = true } };

                case "compile":
                    // Request recompile and wait for it to finish.
                    AssetDatabase.Refresh();
                    bool compiling = EditorApplication.isCompiling;
                    return new Response
                    {
                        ok = true,
                        result = new
                        {
                            wasCompiling = compiling,
                            isCompiling = EditorApplication.isCompiling,
                            note = "Compile triggered. Use /status to poll completion."
                        }
                    };

                case "status":
                    return new Response
                    {
                        ok = true,
                        result = new
                        {
                            isCompiling = EditorApplication.isCompiling,
                            isPlaying = EditorApplication.isPlaying,
                            isPlayingOrWillChangePlaymode = EditorApplication.isPlayingOrWillChangePlaymode,
                            isPaused = EditorApplication.isPaused,
                            isUpdating = EditorApplication.isUpdating,
                            timeSinceStartup = EditorApplication.timeSinceStartup,
                        }
                    };

                case "run-menu":
                {
                    string menuPath = GetArg<string>(args, "menuPath", "");
                    if (string.IsNullOrEmpty(menuPath))
                        return new Response { ok = false, error = "menuPath required" };

                    // Safety: refuse if a modal window is already open. ExecuteMenuItem
                    // is synchronous and blocking; stacking another on top of an existing
                    // modal freezes the main thread and makes the bridge unresponsive.
                    if (EditorGUIUtility.hasModalWindow)
                    {
                        return new Response
                        {
                            ok = false,
                            error = "A modal dialog is currently open in the Editor. Close it before running a menu command. " +
                                "(ExecuteMenuItem is blocking and would freeze the main thread.)"
                        };
                    }

                    bool executed = EditorApplication.ExecuteMenuItem(menuPath);
                    // After execution, check if a modal opened — this likely means the menu
                    // triggered a dialog and the main thread may now be blocked.
                    bool modalOpened = EditorGUIUtility.hasModalWindow;
                    return new Response
                    {
                        ok = executed,
                        result = new { executed, menuPath, modalDialogOpened = modalOpened },
                        error = executed ? null : "Menu item not found: " + menuPath +
                            (modalOpened ? " (note: a modal dialog opened — the Editor may now be blocked)" : "")
                    };
                }

                case "asset-info":
                {
                    string assetPath = GetArg<string>(args, "path", "");
                    if (string.IsNullOrEmpty(assetPath))
                        return new Response { ok = false, error = "path required" };
                    var guid = AssetDatabase.AssetPathToGUID(assetPath);
                    var mainAsset = AssetDatabase.LoadMainAssetAtPath(assetPath);
                    return new Response
                    {
                        ok = mainAsset != null,
                        result = new
                        {
                            path = assetPath,
                            guid = guid,
                            type = mainAsset != null ? mainAsset.GetType().FullName : null,
                            exists = mainAsset != null,
                        }
                    };
                }

                case "log":
                {
                    int count = GetArg<int>(args, "count", 50);
                    string severity = GetArg<string>(args, "severity", "");
                    var entries = GetLogEntries(count, severity);
                    var counts = GetLogCounts();
                    // Also report GetCount() for diagnosis (may differ from GetCountsByType)
                    var asm = typeof(Editor).Assembly;
                    var tLE = asm.GetType("UnityEditor.LogEntries");
                    int getCountValue = -1;
                    if (tLE != null)
                    {
                        var gc = tLE.GetMethod("GetCount", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
                        if (gc != null) { try { getCountValue = (int)gc.Invoke(null, null); } catch { } }
                    }
                    return new Response { ok = true, result = new { entries, count = entries.Count, filter = severity, totalCounts = counts, getCount = getCountValue } };
                }

                case "eval":
                {
                    if (Environment.GetEnvironmentVariable("PI_BRIDGE_ALLOW_EVAL") != "1")
                    {
                        return new Response
                        {
                            ok = false,
                            error = "eval is disabled. Set PI_BRIDGE_ALLOW_EVAL=1 environment variable in Unity to enable."
                        };
                    }
                    string code = GetArg<string>(args, "code", "");
                    if (string.IsNullOrEmpty(code))
                        return new Response { ok = false, error = "code required" };
                    // Evaluating arbitrary C# is non-trivial without compiler APIs.
                    // For now, support calling a static method: "Type.Method" or "Type.Method(arg1,arg2)"
                    object evalResult = EvalExpression(code);
                    return new Response { ok = true, result = new { value = evalResult?.ToString(), type = evalResult?.GetType().FullName } };
                }

                default:
                    return new Response { ok = false, error = "Unknown command: " + command };
            }
        }

        // Minimal "eval": call a static method by "FullName.Method" or "FullName.Method(a,b)".
        private static object EvalExpression(string code)
        {
            int paren = code.IndexOf('(');
            string typeAndMethod = paren >= 0 ? code.Substring(0, paren) : code;
            string[] parts = typeAndMethod.Split('.');
            if (parts.Length < 2)
                throw new Exception("Expected 'Namespace.Type.Method' or 'Type.Method'");

            string methodName = parts[parts.Length - 1];
            string typeName = string.Join(".", parts, 0, parts.Length - 1);

            // Search all assemblies for the type
            Type type = null;
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                type = asm.GetType(typeName);
                if (type != null) break;
            }
            if (type == null) throw new Exception("Type not found: " + typeName);

            var method = type.GetMethod(methodName, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
            if (method == null) throw new Exception("Method not found: " + methodName);

            // Parse simple string args: Method("a", "b")
            object[] methodArgs = null;
            if (paren >= 0)
            {
                string argsStr = code.Substring(paren + 1, code.LastIndexOf(')') - paren - 1);
                if (!string.IsNullOrWhiteSpace(argsStr))
                {
                    var argList = new List<object>();
                    // Naive split — does not handle commas in strings
                    foreach (var a in argsStr.Split(','))
                    {
                        var trimmed = a.Trim().Trim('"');
                        argList.Add(trimmed);
                    }
                    methodArgs = argList.ToArray();
                }
            }

            return method.Invoke(null, methodArgs);
        }

        // Read Unity Console entries via the internal LogEntries API.
        //
        // Uses GetCount() + GetEntry(int, LogEntry) — NOT StartGettingEntries/GetEntryInternal.
        // The StartGettingEntries/GetEntryInternal combo returns 0 entries on some 2019.4
        // projects (returns total=0 from StartGettingEntries even when GetCountsByType
        // reports entries). The GetCount+GetEntry pair is simpler and verified working
        // (e.g. in real projects that also subscribe Application.logMessageReceived).
        //
        // LogEntry fields (UnityCsReference 2019.4): message, file, line, column, mode, instanceID, identifier
        // mode bit flags: 1=Error, 2=Assert, 4=Warning, 8=Log, 16=Exception
        private static List<object> GetLogEntries(int count, string severityFilter)
        {
            var result = new List<object>();
            var asm = typeof(Editor).Assembly;
            var logEntriesType = asm.GetType("UnityEditor.LogEntries");
            var logEntryType = asm.GetType("UnityEditor.LogEntry");
            if (logEntriesType == null || logEntryType == null)
            {
                result.Add(new { message = "[PiBridge] LogEntries/LogEntry type not found", file = (string)null, line = 0, column = 0, mode = 3, severity = "error" });
                return result;
            }

            BindingFlags bf = BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
            var getCount = logEntriesType.GetMethod("GetCount", bf);
            // GetEntry (not GetEntryInternal) is the right call inside a Start/End session.
            // GetEntryInternal expects an active GettingEntries session and asserts otherwise.
            // GetEntry also needs the session but is the documented pairing with GetCount.
            var getEntry = logEntriesType.GetMethod("GetEntry", bf);
            var startGettingEntries = logEntriesType.GetMethod("StartGettingEntries", bf);
            var endGettingEntries = logEntriesType.GetMethod("EndGettingEntries", bf);
            if (getCount == null || getEntry == null)
            {
                // Fallback: some versions only expose GetEntryInternal
                getEntry = logEntriesType.GetMethod("GetEntryInternal", bf) ?? getEntry;
                if (getCount == null || getEntry == null)
                {
                    result.Add(new { message = "[PiBridge] GetCount/GetEntry methods not found", file = (string)null, line = 0, column = 0, mode = 3, severity = "error" });
                    return result;
                }
            }

            var fMsg = logEntryType.GetField("message");
            var fMode = logEntryType.GetField("mode");
            var fFile = logEntryType.GetField("file");
            var fLine = logEntryType.GetField("line");
            var fCol = logEntryType.GetField("column");

            try
            {
                int total = (int)getCount.Invoke(null, null);
                int start = Math.Max(0, total - count);
                // Wrap the read loop in StartGettingEntries/EndGettingEntries.
                // GetEntry asserts "m_IsGettingEntries" if called outside a session,
                // producing a harmless-but-noisy assertion in the console.
                if (startGettingEntries != null) startGettingEntries.Invoke(null, null);
                // Read from oldest to newest in the requested window
                for (int i = start; i < total; i++)
                {
                    object entry;
                    try { entry = Activator.CreateInstance(logEntryType); }
                    catch { continue; }
                    getEntry.Invoke(null, new object[] { i, entry });

                    string message = fMsg != null ? (string)fMsg.GetValue(entry) : "";
                    string file = fFile != null ? (string)fFile.GetValue(entry) : "";
                    int line = fLine != null ? (int)fLine.GetValue(entry) : 0;
                    int column = fCol != null ? (int)fCol.GetValue(entry) : 0;
                    int mode = fMode != null ? (int)fMode.GetValue(entry) : 0;
                    string severity = ModeToSeverity(mode);

                    // Apply severity filter
                    if (!string.IsNullOrEmpty(severityFilter))
                    {
                        bool keep = severity.Equals(severityFilter, StringComparison.OrdinalIgnoreCase);
                        // "error" filter also keeps assert + exception
                        if (!keep && severityFilter.Equals("error", StringComparison.OrdinalIgnoreCase) &&
                            (severity == "assert" || severity == "exception"))
                            keep = true;
                        if (!keep) continue;
                    }

                    result.Add(new { message, file, line, column, mode, severity });
                }
            }
            catch (Exception e)
            {
                result.Add(new { message = "[PiBridge] Failed to read log: " + e.Message, file = (string)null, line = 0, column = 0, mode = 3, severity = "error" });
            }
            finally
            {
                // Always end the session if we started one, even on exception
                if (startGettingEntries != null && endGettingEntries != null)
                {
                    try { endGettingEntries.Invoke(null, null); } catch { }
                }
            }
            return result;
        }

        // Map LogEntry.mode bit flags to a severity string.
        // Mode bits (from Unity ConsoleWindow/LogEntries): Error=1, Assert=2, Warning=4, Log=8, Exception=16
        private static string ModeToSeverity(int mode)
        {
            if ((mode & 1) != 0) return "error";
            if ((mode & 2) != 0) return "assert";
            if ((mode & 16) != 0) return "exception";
            if ((mode & 4) != 0) return "warning";
            if ((mode & 8) != 0) return "log";
            return "log";
        }

        // Get raw console entry counts by type, for debugging.
        // Uses GetCountsByType(ref int errorCount, ref int warningCount, ref int logCount).
        private static object GetLogCounts()
        {
            var logEntriesType = Type.GetType("UnityEditor.LogEntries, UnityEditor");
            if (logEntriesType == null) return new { error = -1, warning = -1, log = -1, note = "LogEntries type not found" };
            var getCountsByType = logEntriesType.GetMethod("GetCountsByType", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            var getConsoleFlags = logEntriesType.GetProperty("consoleFlags", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            if (getCountsByType == null) return new { error = -1, warning = -1, log = -1, note = "GetCountsByType not found" };
            try
            {
                object[] parms = new object[] { 0, 0, 0 };
                getCountsByType.Invoke(null, parms);
                int flags = getConsoleFlags != null ? (int)getConsoleFlags.GetValue(null, null) : -1;
                return new { error = (int)parms[0], warning = (int)parms[1], log = (int)parms[2], consoleFlags = flags };
            }
            catch (Exception e)
            {
                return new { error = -1, warning = -1, log = -1, note = e.Message };
            }
        }

        private static Dictionary<string, object> ParseArgs(string body)
        {
            if (string.IsNullOrWhiteSpace(body)) return new Dictionary<string, object>();
            // Minimal JSON parser for flat objects (avoids depending on JsonUtility
            // which requires [Serializable] types). Handles string/number/bool/null.
            return SimpleJson.Parse(body);
        }

        private static T GetArg<T>(Dictionary<string, object> args, string key, T defaultValue)
        {
            if (args == null || !args.TryGetValue(key, out object value)) return defaultValue;
            if (value is T t) return t;
            try { return (T)Convert.ChangeType(value, typeof(T)); } catch { return defaultValue; }
        }

        private static void WriteJson(HttpListenerResponse response, object obj)
        {
            string json = SimpleJson.ToJson(obj);
            byte[] bytes = Encoding.UTF8.GetBytes(json);
            response.ContentType = "application/json; charset=utf-8";
            response.ContentLength64 = bytes.Length;
            response.OutputStream.Write(bytes, 0, bytes.Length);
        }

        // Clean up on domain reload / quit
        [InitializeOnLoadMethod]
        private static void RegisterShutdown()
        {
            AssemblyReloadEvents.beforeAssemblyReload += Stop;
        }

        private static void Stop()
        {
            lock (_lock)
            {
                try { _listener?.Stop(); } catch { }
                _listener = null;
            }
        }
    }

    // Brings the Unity Editor window to the foreground so the main thread runs
    // at full speed (bypassing the ~1Hz delayCall throttle when unfocused).
    // Windows-only P/Invoke; no-ops on macOS/Linux where the throttle is less
    // aggressive and SetForegroundWindow is unavailable.
    internal static class WindowFocus
    {
        private static IntPtr _cachedHwnd = IntPtr.Zero;

#if UNITY_EDITOR_WIN
        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr lpdwProcessId);

        [DllImport("user32.dll")]
        private static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool BringWindowToTop(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, IntPtr dwExtraInfo);

        private const int SW_RESTORE = 9;
        private const byte VK_MENU = 0x12; // ALT
        private const uint KEYEVENTF_KEYUP = 0x0002;
#endif

        public static void BringUnityToFront()
        {
#if UNITY_EDITOR_WIN
            try
            {
                IntPtr hwnd = GetUnityHwnd();
                if (hwnd == IntPtr.Zero) return;

                // Restore if minimized, so SetForegroundWindow can take effect.
                ShowWindow(hwnd, SW_RESTORE);

                IntPtr fg = GetForegroundWindow();

                // Windows restricts SetForegroundWindow from background threads/processes
                // that don't already own the foreground (the "foreground lock"). The
                // reliable workaround is to AttachThreadInput to the foreground thread
                // (so we share its foreground entitlement) before calling SFW. If that
                // still fails, simulate an ALT keypress: Windows treats synthetic
                // keyboard input as a user gesture and relaxes the lock for the
                // subsequent SFW call.
                bool sfw = TrySetForeground(hwnd, fg);

                // Fallbacks if SFW was rejected.
                if (!sfw)
                {
                    BringWindowToTop(hwnd);
                    // Simulate ALT keydown/up to satisfy the foreground-lock gesture test.
                    keybd_event(VK_MENU, 0, 0, IntPtr.Zero);
                    keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, IntPtr.Zero);
                    SetForegroundWindow(hwnd);
                }
            }
            catch
            {
                // Focus manipulation is best-effort; never fail a command because of it.
            }
#endif
        }

        // Attempt SetForegroundWindow with AttachThreadInput bypass. Returns the
        // SFW return value (false if the foreground lock rejected it).
        private static bool TrySetForeground(IntPtr hwnd, IntPtr fg)
        {
            if (fg == IntPtr.Zero)
                return SetForegroundWindow(hwnd);

            uint fgThread = GetWindowThreadProcessId(fg, IntPtr.Zero);
            uint ourThread = GetCurrentThreadId();
            if (fgThread == ourThread)
                return SetForegroundWindow(hwnd);

            bool attach = AttachThreadInput(ourThread, fgThread, true);
            bool sfw = SetForegroundWindow(hwnd);
            AttachThreadInput(ourThread, fgThread, false);
            return sfw;
        }

        // Find the Unity main window handle. Cached after first success.
        private static IntPtr GetUnityHwnd()
        {
#if UNITY_EDITOR_WIN
            // Validate the cached handle; window handles can become invalid after
            // domain reload or if Unity recreates its main window.
            if (_cachedHwnd != IntPtr.Zero && IsWindow(_cachedHwnd))
                return _cachedHwnd;
            _cachedHwnd = IntPtr.Zero;

            try
            {
                // The current process's MainWindowHandle is the Editor's main window.
                // Refresh to pick up the latest handle (it can change after reload).
                var proc = System.Diagnostics.Process.GetCurrentProcess();
                proc.Refresh();
                if (!string.IsNullOrEmpty(proc.MainWindowTitle) && proc.MainWindowHandle != IntPtr.Zero)
                {
                    _cachedHwnd = proc.MainWindowHandle;
                }
                else
                {
                    // Fallback: enumerate top-level windows and find one owned by this
                    // process that is visible and has a non-empty title.
                    _cachedHwnd = FindUnityWindowByEnumeration();
                }
            }
            catch { }
#endif
            return _cachedHwnd;
        }

#if UNITY_EDITOR_WIN
        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        private static IntPtr FindUnityWindowByEnumeration()
        {
            IntPtr found = IntPtr.Zero;
            uint ourPid = (uint)System.Diagnostics.Process.GetCurrentProcess().Id;
            EnumWindows((hWnd, _l) =>
            {
                if (!IsWindowVisible(hWnd)) return true;
                var sb = new System.Text.StringBuilder(256);
                GetWindowText(hWnd, sb, 256);
                if (sb.Length == 0) return true;
                uint pid;
                GetWindowThreadProcessId(hWnd, out pid);
                if (pid == ourPid) { found = hWnd; return false; }
                return true;
            }, IntPtr.Zero);
            return found;
        }
#endif
    }

    // Response envelope
    internal class Response
    {
        public bool ok;
        public object result;
        public string error;
        public int durationMs;
    }

    // Minimal JSON serializer/parser (no dependencies, handles flat objects
    // and nested via reflection). Good enough for the bridge's simple payloads.
    internal static class SimpleJson
    {
        public static string ToJson(object obj)
        {
            var sb = new StringBuilder();
            WriteValue(sb, obj);
            return sb.ToString();
        }

        private static void WriteValue(StringBuilder sb, object obj)
        {
            if (obj == null) { sb.Append("null"); return; }
            var t = obj.GetType();
            if (t == typeof(string)) { WriteString(sb, (string)obj); return; }
            if (t == typeof(bool)) { sb.Append((bool)obj ? "true" : "false"); return; }
            if (t.IsPrimitive || t == typeof(decimal)) { sb.Append(Convert.ToString(obj, System.Globalization.CultureInfo.InvariantCulture)); return; }
            if (t.IsArray || t.GetInterface(nameof(System.Collections.IEnumerable)) != null)
            {
                sb.Append('[');
                bool first = true;
                foreach (var item in (System.Collections.IEnumerable)obj)
                {
                    if (!first) sb.Append(',');
                    WriteValue(sb, item);
                    first = false;
                }
                sb.Append(']');
                return;
            }
            // Object: serialize public fields and properties
            sb.Append('{');
            bool f = true;
            foreach (var field in t.GetFields())
            {
                if (!f) sb.Append(',');
                WriteString(sb, field.Name); sb.Append(':');
                WriteValue(sb, field.GetValue(obj));
                f = false;
            }
            foreach (var prop in t.GetProperties())
            {
                if (!f) sb.Append(',');
                WriteString(sb, prop.Name); sb.Append(':');
                try { WriteValue(sb, prop.GetValue(obj, null)); } catch { sb.Append("null"); }
                f = false;
            }
            sb.Append('}');
        }

        private static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 32) sb.AppendFormat("\\u{0:x4}", (int)c);
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }

        public static Dictionary<string, object> Parse(string json)
        {
            var p = new Parser(json);
            p.SkipWhitespace();
            var result = p.ParseObject();
            return result;
        }

        private struct Parser
        {
            private readonly string s;
            private int i;
            public Parser(string json) { s = json; i = 0; }

            public Dictionary<string, object> ParseObject()
            {
                var dict = new Dictionary<string, object>();
                if (s[i] != '{') throw new FormatException("Expected {");
                i++;
                SkipWhitespace();
                if (i < s.Length && s[i] == '}') { i++; return dict; }
                while (true)
                {
                    SkipWhitespace();
                    string key = ParseString();
                    SkipWhitespace();
                    if (s[i] != ':') throw new FormatException("Expected :");
                    i++;
                    SkipWhitespace();
                    object value = ParseValue();
                    dict[key] = value;
                    SkipWhitespace();
                    if (i >= s.Length) break;
                    if (s[i] == ',') { i++; continue; }
                    if (s[i] == '}') { i++; break; }
                    break;
                }
                return dict;
            }

            private object ParseValue()
            {
                SkipWhitespace();
                if (s[i] == '"') return ParseString();
                if (s[i] == '{') return ParseObject();
                if (s[i] == '[') return ParseArray();
                if (s[i] == 't') { i += 4; return true; }
                if (s[i] == 'f') { i += 5; return false; }
                if (s[i] == 'n') { i += 4; return null; }
                // number
                int start = i;
                while (i < s.Length && "-0123456789.eE+".IndexOf(s[i]) >= 0) i++;
                string num = s.Substring(start, i - start);
                if (num.Contains(".") || num.Contains("e") || num.Contains("E"))
                    return double.Parse(num, System.Globalization.CultureInfo.InvariantCulture);
                return long.Parse(num, System.Globalization.CultureInfo.InvariantCulture);
            }

            private List<object> ParseArray()
            {
                var list = new List<object>();
                i++; // skip [
                SkipWhitespace();
                if (s[i] == ']') { i++; return list; }
                while (true)
                {
                    list.Add(ParseValue());
                    SkipWhitespace();
                    if (s[i] == ',') { i++; SkipWhitespace(); continue; }
                    if (s[i] == ']') { i++; break; }
                    break;
                }
                return list;
            }

            private string ParseString()
            {
                if (s[i] != '"') throw new FormatException("Expected string");
                i++;
                var sb = new StringBuilder();
                while (i < s.Length && s[i] != '"')
                {
                    if (s[i] == '\\')
                    {
                        i++;
                        char c = s[i];
                        switch (c)
                        {
                            case '"': sb.Append('"'); break;
                            case '\\': sb.Append('\\'); break;
                            case '/': sb.Append('/'); break;
                            case 'n': sb.Append('\n'); break;
                            case 'r': sb.Append('\r'); break;
                            case 't': sb.Append('\t'); break;
                            case 'u': sb.Append((char)Convert.ToInt32(s.Substring(i + 1, 4), 16)); i += 4; break;
                            default: sb.Append(c); break;
                        }
                        i++;
                    }
                    else { sb.Append(s[i]); i++; }
                }
                i++; // skip closing quote
                return sb.ToString();
            }

            public void SkipWhitespace()
            {
                while (i < s.Length && char.IsWhiteSpace(s[i])) i++;
            }
        }
    }
}
