using System;
using System.Runtime.InteropServices;

namespace PiBridge
{
    // Brings the Unity Editor window to the foreground so main-thread dispatch
    // runs at full speed (bypassing the ~1Hz delayCall throttle when unfocused).
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
}
