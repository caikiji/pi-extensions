/*
 * UnityEvents — non-blocking event queue + SSE source for PiBridge.
 *
 * Maintains a thread-safe event queue filled by main-thread Unity callbacks
 * (EditorApplication.update for compile-state transitions, playModeStateChanged
 * for play-mode transitions). The Bridge's /events SSE endpoint drains this
 * queue and streams events to the connected client (the pi extension), which
 * injects them into the agent via pi.sendUserMessage — no polling, no waiting.
 *
 * Domain reload: [InitializeOnLoadMethod] re-registers the callbacks on every
 * reload. The queue/subscriptions are static and thus cleared on reload too;
 * the client reconnects (see unity-events.ts) and re-subscribes. Events that
 * fire during the reload window are lost by design — there is no Editor
 * process to observe them.
 *
 * Subscription filter: only event types the client subscribed to are enqueued,
 * so an idle/unsubscribed bridge does zero allocation in the hot path.
 */
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using UnityEditor;
using UnityEngine;

namespace PiBridge
{
    // A single queued event. Type is the SSE event name; Data is serialized as
    // the SSE data: line (any JSON-serializable object, or null).
    internal sealed class UnityEvent
    {
        public string Type;
        public object Data;
    }

    internal static class UnityEvents
    {
        private static readonly ConcurrentQueue<UnityEvent> _queue = new ConcurrentQueue<UnityEvent>();
        private static readonly ConcurrentDictionary<string, bool> _subs = new ConcurrentDictionary<string, bool>();
        private static bool _wasCompiling;

        // Re-registered on every domain reload by Unity. EditorApplication.update
        // and playModeStateChanged are static events that do not survive reload,
        // so this is the single place they get (re-)attached.
        [InitializeOnLoadMethod]
        private static void Register()
        {
            // -= then += guards against double-subscription if Register ever runs
            // twice in one domain (it shouldn't, but the cost is negligible).
            EditorApplication.update -= DetectCompileState;
            EditorApplication.update += DetectCompileState;
            EditorApplication.playModeStateChanged -= OnPlayModeStateChanged;
            EditorApplication.playModeStateChanged += OnPlayModeStateChanged;
        }

        // Drain the queue from the SSE handler (background thread).
        public static bool TryDequeue(out UnityEvent ev)
        {
            return _queue.TryDequeue(out ev);
        }

        // manage-subscriptions command. eventsArg is whatever SimpleJson handed us
        // (List<object>, object[], or string) — normalized here so the caller does
        // not need to know SimpleJson's array representation.
        public static Response Manage(string action, object eventsArg)
        {
            string[] events = NormalizeEvents(eventsArg);
            switch (action ?? "")
            {
                case "subscribe":
                    foreach (var e in events) _subs[e] = true;
                    break;
                case "unsubscribe":
                    foreach (var e in events) _subs.TryRemove(e, out _);
                    break;
                case "list":
                    return new Response { ok = true, result = new { events = _subs.Keys.ToArray() } };
                default:
                    return new Response { ok = false, error = "action required (subscribe/unsubscribe/list)" };
            }
            return new Response { ok = true, result = new { action, events, subscribed = _subs.Keys.ToArray() } };
        }

        private static void Enqueue(string type, object data = null)
        {
            // Cheap fast path: nobody subscribed to anything → drop. Keeps the
            // hot path (every update tick) allocation-free when idle.
            if (_subs.Count == 0) return;
            if (!_subs.ContainsKey(type)) return;
            _queue.Enqueue(new UnityEvent { Type = type, Data = data });
        }

        // Poll isCompiling transitions from update. Unity exposes no event for
        // "compile finished", so edge-detection on the bool is the standard approach.
        private static void DetectCompileState()
        {
            bool isCompiling = EditorApplication.isCompiling;
            if (isCompiling && !_wasCompiling)
                Enqueue("compile_started");
            else if (!isCompiling && _wasCompiling)
                Enqueue("compile_done", new { errors = GetErrorCount() });
            _wasCompiling = isCompiling;
        }

        private static void OnPlayModeStateChanged(PlayModeStateChange state)
        {
            if (state == PlayModeStateChange.EnteredPlayMode)
                Enqueue("playmode_entered");
            else if (state == PlayModeStateChange.EnteredEditMode)
                Enqueue("playmode_exited");
        }

        // Current console error count via the internal LogEntries API (same
        // reflection path GetLogCounts uses in PiBridge.cs). Reported at
        // compile_done so the agent knows whether the compile produced errors.
        private static int GetErrorCount()
        {
            var t = Type.GetType("UnityEditor.LogEntries, UnityEditor");
            if (t == null) return -1;
            var m = t.GetMethod("GetCountsByType", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            if (m == null) return -1;
            try
            {
                var p = new object[] { 0, 0, 0 };
                m.Invoke(null, p);
                return (int)p[0];
            }
            catch { return -1; }
        }

        private static string[] NormalizeEvents(object arg)
        {
            if (arg == null) return Array.Empty<string>();
            if (arg is string[] s) return s;
            if (arg is string single) return new[] { single };
            if (arg is System.Collections.IList list)
            {
                var r = new List<string>(list.Count);
                foreach (var x in list) r.Add(x?.ToString() ?? "");
                return r.ToArray();
            }
            return Array.Empty<string>();
        }
    }
}
