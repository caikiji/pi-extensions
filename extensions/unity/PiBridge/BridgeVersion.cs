namespace PiBridge
{
    // Single source of truth for the bridge version. The TS client checks this
    // via the 'ping' command; if it's older than MIN_BRIDGE_VERSION the client
    // refuses to send commands and tells the user to reinstall.
    //
    // Keep this in its own file so that a missing file (e.g. partial manual
    // install) breaks ping immediately, rather than letting an incomplete bridge
    // report a valid version.
    internal static class BridgeVersion
    {
        public const string Value = "0.6.0";
        // 0.6.0: Roslyn-backed eval (CSharpScript) replaces reflection-based EvalExpression;
        //        arbitrary C# snippets compile+run on the main thread with full Unity API access.
        //        see RoslynEval.cs. Bridge ships Roslyn DLLs (unity_install_bridge provisions them).
    }
}
