/*
 * RoslynEval — Roslyn-backed C# scripting for the `eval` command.
 *
 * Replaces the old reflection-based EvalExpression: instead of only being able
 * to call "Type.Method(args)", the agent can now submit any C# snippet —
 * expressions, multi-statement blocks, LINQ, loops, new GameObjects, AssetDatabase
 * queries, etc. — and it is compiled + executed on the Editor main thread with
 * full Unity API access.
 *
 * Why a separate file: keeps the Roslyn dependency isolated here. PiBridge.cs's
 * `eval` case just calls RoslynEval.Run(code). The Roslyn DLLs (under
 * PiBridge/Roslyn/<version>/) are a compile+runtime dependency — unity_install_bridge
 * always provisions them. If a Unity version's Mono runtime rejects the shipped
 * DLLs at load time, Run() catches the load exception and returns a clear error
 * pointing to reinstall; the rest of the bridge keeps working.
 *
 * Threading / async (v1 limitation):
 *   ExecuteCommand runs on the main thread (via EditorApplication.delayCall).
 *   CSharpScript.RunAsync returns a Task. Synchronous scripts (no await) complete
 *   before the Task is returned, so GetAwaiter().GetResult() returns instantly.
 *   Scripts that `await` something needing the main thread can deadlock (the main
 *   thread is blocked in GetResult and cannot run the continuation), or resume on
 *   a ThreadPool thread where Unity API calls would throw. Therefore async/await
 *   in eval scripts is UNSUPPORTED in v1 — write synchronous code. The DispatchToMainThread
 *   120s timeout still protects against runaway scripts.
 *
 * State (v1): each eval is a fresh submission — no shared globals object, so
 * locals do not persist across calls. ScriptOptions is rebuilt every call so it
 * picks up the current AppDomain assemblies after a domain reload (Roslyn's own
 * caches are also wiped by reload, which is fine).
 *
 * Return value serialization: see SerializeReturnValue. Bounded + cycle-guarded
 * so a returned GameObject / scene graph can never produce an unbounded payload.
 *
 * License: MIT
 */

using System;
using System.Collections;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Scripting;
using Microsoft.CodeAnalysis.Scripting;
using UnityEditor;
using UnityEngine;

namespace PiBridge
{
    internal static class RoslynEval
    {
        // Cached set of well-known UnityEngine value types whose public fields
        // are all primitives — safe to let SimpleJson reflect directly so the
        // agent gets {"x":1,"y":2,"z":3} instead of a ToString capsule.
        private static readonly HashSet<string> _unityValueTypes = new HashSet<string>
        {
            "Vector2", "Vector3", "Vector4",
            "Vector2Int", "Vector3Int",
            "Quaternion", "Color", "Color32",
            "Rect", "RectInt", "Bounds", "BoundsInt",
            "Plane", "Ray", "Ray2D",
        };

        public static Response Run(string code)
        {
            ScriptOptions options;
            try
            {
                options = BuildScriptOptions();
            }
            catch (Exception e)
            {
                // Most likely a Roslyn assembly failed to load on this Unity/Mono
                // runtime. Surface a clear error — the other bridge commands still
                // work; only eval is degraded.
                return new Response
                {
                    ok = false,
                    error = "Roslyn eval is unavailable on this Unity runtime: " + e.GetType().Name + ": " + e.Message +
                            "\nReinstall via unity_install_bridge (it picks the Roslyn version for this Unity). " +
                            "If it still fails, the project may need an older Unity or the reflection-based eval.",
                };
            }

            try
            {
                // Create the script and force a compile so we get clean diagnostics
                // (with line/col) rather than a wrapped CompilationErrorException.
                Script<object> script = CSharpScript.Create(code, options);
                Compilation compilation = script.GetCompilation();
                var allDiag = compilation.GetDiagnostics();
                var errors = allDiag.Where(d => d.Severity == DiagnosticSeverity.Error).ToList();
                if (errors.Count > 0)
                {
                    return new Response
                    {
                        ok = false,
                        error = "Compilation error: " + string.Join("  |  ", errors.Select(FormatDiagnostic)),
                        result = new
                        {
                            kind = "compile",
                            diagnostics = errors.Select(FormatDiagnosticObject).ToArray(),
                            warnings = allDiag.Where(d => d.Severity == DiagnosticSeverity.Warning).Take(20).Select(FormatDiagnosticObject).ToArray(),
                        },
                    };
                }

                // Run on the main thread. For synchronous scripts the Task is
                // already completed; GetResult returns at once. (See file header
                // re: async being unsupported in v1.)
                ScriptState<object> state;
                try
                {
                    state = script.RunAsync().GetAwaiter().GetResult();
                }
                catch (CompilationErrorException cee)
                {
                    // Defensive: pre-check above should have caught these, but
                    // RunAsync can still throw if deferred diagnostics surface.
                    // cee.Diagnostics is ImmutableArray<Diagnostic> (a struct,
                    // never null but may be default/uninitialized) — normalize to
                    // a safe IEnumerable<Diagnostic>.
                    ImmutableArray<Diagnostic> diagsArr = cee.Diagnostics;
                    IEnumerable<Diagnostic> diags = diagsArr.IsDefault ? Enumerable.Empty<Diagnostic>() : diagsArr;
                    return new Response
                    {
                        ok = false,
                        error = "Compilation error (runtime): " + string.Join("  |  ", diags.Select(FormatDiagnostic)),
                        result = new { kind = "compile", diagnostics = diags.Select(FormatDiagnosticObject).ToArray() },
                    };
                }

                object returnValue = state.ReturnValue;
                return new Response
                {
                    ok = true,
                    result = new
                    {
                        value = SerializeReturnValue(returnValue, new HashSet<object>(ReferenceComparer)),
                        type = returnValue?.GetType().FullName,
                        hasReturnValue = returnValue != null || HasTrailingValue(state),
                    },
                };
            }
            catch (Exception e)
            {
                // Unwrap common reflection-invoked exceptions for cleaner messages.
                string stack = e.StackTrace;
                return new Response
                {
                    ok = false,
                    error = "eval threw " + e.GetType().Name + ": " + e.Message,
                    result = new { kind = "runtime", type = e.GetType().FullName, stack = Truncate(stack, 4000) },
                };
            }
        }

        // Build ScriptOptions from the currently-loaded assemblies. The Editor
        // AppDomain at eval time has UnityEngine/UnityEditor, all package and
        // user assemblies loaded — so the script can reference any of them.
        // Filtering: skip dynamic assemblies (no Location) and assemblies whose
        // Location throws or is empty (some Mono reflection-emit assemblies).
        private static ScriptOptions BuildScriptOptions()
        {
            var refs = new List<MetadataReference>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                try
                {
                    if (asm.IsDynamic) continue;
                    string loc = asm.Location;
                    if (string.IsNullOrEmpty(loc)) continue;
                    // Normalize separators to dedupe mixed-path entries.
                    string key = loc.Replace('\\', '/');
                    if (!seen.Add(key)) continue;
                    refs.Add(MetadataReference.CreateFromFile(loc));
                }
                catch { /* Location access can throw on some assemblies */ }
            }

            return ScriptOptions.Default
                .WithReferences(refs)
                .WithImports(
                    "System",
                    "System.IO",
                    "System.Linq",
                    "System.Collections.Generic",
                    "System.Reflection",
                    "UnityEngine",
                    "UnityEditor"
                )
                .WithEmitDebugInformation(false)
                .WithLanguageVersion(LanguageVersion.Latest);
        }

        // ─── Return-value serialization ───────────────────────────────────────
        //
        // SimpleJson reflects public fields+properties of any object. That is
        // dangerous for arbitrary Unity objects (huge graphs, throwing getters,
        // circular refs). SerializeReturnValue converts the value into a bounded,
        // cycle-safe representation BEFORE SimpleJson sees it:
        //   - null / primitive / string / decimal / enum  -> passthrough
        //   - common UnityEngine value types (Vector3...)  -> passthrough (SimpleJson reflects primitive fields)
        //   - IEnumerable                                    -> List<object> of recursively-serialized items, capped at 50
        //   - "plain" objects (anonymous/DTO, not UnityEngine.Object) -> Dictionary<string,object> of recursively-serialized props
        //   - anything else (GameObject, Component, Type...) -> { type, toString } capsule
        //
        // SimpleJson (enhanced) emits Dictionary as a JSON object.

        private static object SerializeReturnValue(object value, HashSet<object> visited, int depth = 0)
        {
            if (value == null) return null;
            if (depth > 6) return Capsule(value, "depth-limit");

            Type t = value.GetType();

            // Primitives, string, decimal, enum: safe passthrough.
            if (t == typeof(string) || t.IsPrimitive || t == typeof(decimal) || t.IsEnum)
                return value;

            // Common Unity value types: SimpleJson reflects their primitive fields.
            if (IsUnityValueType(t)) return value;

            // Collections (but not string, already handled).
            if (value is IEnumerable)
            {
                var list = new List<object>();
                int n = 0;
                foreach (var item in (IEnumerable)value)
                {
                    if (n++ >= 50) { list.Add("...(truncated at 50 items)"); break; }
                    list.Add(SerializeReturnValue(item, visited, depth + 1));
                }
                return list;
            }

            // Reference types: cycle guard. Value types can't cycle, skip the set.
            if (!t.IsValueType)
            {
                if (!visited.Add(value)) return Capsule(value, "cycle");
            }

            // Plain objects (anonymous types, user DTOs) — NOT UnityEngine.Object
            // derivatives and NOT System.Reflection metadata types (huge graphs).
            if (IsPlainObject(t))
            {
                var dict = new Dictionary<string, object>();
                int n = 0;
                foreach (var prop in t.GetProperties(BindingFlags.Public | BindingFlags.Instance))
                {
                    // Skip indexers (they have parameters) — can't be read meaningfully.
                    if (prop.GetIndexParameters().Length > 0) continue;
                    try
                    {
                        var v = prop.GetValue(value, null);
                        dict[prop.Name] = SerializeReturnValue(v, visited, depth + 1);
                    }
                    catch (TargetInvocationException tie)
                    {
                        dict[prop.Name] = "<get threw: " + (tie.InnerException?.GetType().Name ?? tie.GetType().Name) + ">";
                    }
                    catch (Exception e)
                    {
                        dict[prop.Name] = "<get threw: " + e.GetType().Name + ">";
                    }
                    if (++n >= 50) { dict["_(truncated)"] = "stopped at 50 properties"; break; }
                }
                // If the object exposed no serializable properties, capsule it so
                // the agent at least sees the type + ToString.
                if (dict.Count == 0) return Capsule(value, null);
                return dict;
            }

            // Anything else (GameObject, Component, Type, MemberInfo, ...).
            return Capsule(value, null);
        }

        private static bool IsUnityValueType(Type t)
        {
            return t.IsValueType && t.Namespace == "UnityEngine" && _unityValueTypes.Contains(t.Name);
        }

        // A "plain" object is one we can safely reflect over: not a Unity engine
        // object (those have expensive/throwing property graphs), not a reflection
        // metadata object, and it has at least one public property. Anonymous
        // types and user DTOs qualify.
        private static bool IsPlainObject(Type t)
        {
            if (typeof(UnityEngine.Object).IsAssignableFrom(t)) return false;
            if (typeof(MemberInfo).IsAssignableFrom(t)) return false;
            if (typeof(Type).IsAssignableFrom(t)) return false;
            if (typeof(Assembly).IsAssignableFrom(t)) return false;
            if (t == typeof(object)) return false;
            return t.GetProperties(BindingFlags.Public | BindingFlags.Instance).Length > 0;
        }

        // { type, toString } capsule. toString is truncated to keep payloads small.
        private static object Capsule(object value, string reason)
        {
            string s;
            try { s = value?.ToString() ?? "null"; }
            catch (Exception e) { s = "<ToString threw: " + e.GetType().Name + ">"; }
            s = Truncate(s, 1000);
            var capsule = new Dictionary<string, object>
            {
                { "type", value?.GetType().FullName ?? "null" },
                { "toString", s },
            };
            if (!string.IsNullOrEmpty(reason)) capsule["capsuleReason"] = reason;
            return capsule;
        }

        // ─── Diagnostics formatting ───────────────────────────────────────────

        private static string FormatDiagnostic(Diagnostic d)
        {
            var ls = d.Location.GetMappedLineSpan();
            string where = ls.IsValid && ls.Path != null
                ? (ls.Path + "(" + (ls.StartLinePosition.Line + 1) + "," + (ls.StartLinePosition.Character + 1) + ")")
                : "<no location>";
            return where + ": " + d.Severity + " " + d.Id + ": " + d.GetMessage();
        }

        private static object FormatDiagnosticObject(Diagnostic d)
        {
            var ls = d.Location.GetMappedLineSpan();
            return new
            {
                severity = d.Severity.ToString(),
                id = d.Id,
                message = d.GetMessage(),
                file = ls.IsValid ? ls.Path : null,
                line = ls.IsValid ? ls.StartLinePosition.Line + 1 : 0,
                column = ls.IsValid ? ls.StartLinePosition.Character + 1 : 0,
            };
        }

        // ─── Small helpers ─────────────────────────────────────────────────────

        // ScriptState has no public "was there a trailing value?" flag; a null
        // ReturnValue is ambiguous (script returned null, or had no trailing
        // expression). Treat null return as "no value" for the hasReturnValue flag
        // — the agent can still read the type (null) if it cares.
        private static bool HasTrailingValue(ScriptState<object> state)
        {
            return state.ReturnValue != null;
        }

        private static string Truncate(string s, int max)
        {
            if (s == null) return null;
            return s.Length <= max ? s : s.Substring(0, max) + "...(truncated)";
        }

        // A Comparer that uses reference identity, so the cycle-guard HashSet
        // compares object instances by reference (not by Equals, which Unity
        // objects override in surprising ways).
        private static IEqualityComparer<object> ReferenceComparer { get; } = new ReferenceIdentityComparer();

        private sealed class ReferenceIdentityComparer : IEqualityComparer<object>
        {
            public bool Equals(object x, object y) => ReferenceEquals(x, y);
            public int GetHashCode(object obj) => System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(obj);
        }
    }
}
