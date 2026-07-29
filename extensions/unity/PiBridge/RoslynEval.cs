/*
 * RoslynEval — Roslyn-backed C# scripting for the `eval` command.
 *
 * Compiles + executes arbitrary C# snippets on the Editor main thread with full
 * Unity API access. See README.md → "Roslyn eval".
 *
 * ─── Why CSharpCompilation + Assembly.Load, NOT CSharpScript ─────────────────
 * The earlier implementation used Microsoft.CodeAnalysis.CSharp.Scripting's
 * CSharpScript.Create/RunAsync. That path compiles fine but, at EXECUTION time,
 * loads the emitted assembly via:
 *
 *     Script.RunAsync
 *       → ScriptBuilder.CreateExecutor
 *         → InteractiveAssemblyLoader.LoadAssemblyFromStream
 *           → CoreAssemblyLoaderImpl.LoadFromStream
 *             → AssemblyLoadContext.LoadFromStream   ← only on .NET Core+
 *
 * Unity's Mono runtime has no System.Runtime.Loader.AssemblyLoadContext (that is
 * a .NET Core+ API), so LoadFromStream throws NotImplementedException on EVERY
 * eval — even `1+1`. The shipped Roslyn netstandard2.0 DLLs load fine (so
 * BuildReferences / GetDiagnostics work), but the Scripting API's execution
 * layer is unusable on Mono.
 *
 * Fix: drop the Scripting API entirely. Use the Compiler API directly:
 *   CSharpSyntaxTree.ParseText → CSharpCompilation.Create → Emit(MemoryStream)
 *   → Assembly.Load(byte[])          ← Mono supports this natively
 *   → reflect the entry method, invoke, serialize the return value.
 *
 * This is the same approach used by community Unity Roslyn tools (e.g.
 * CoplayDev/unity-mcp RoslynRuntimeCompiler) and works on every Unity Mono.
 *
 * ─── Return-value semantics (emulating CSharpScript) ────────────────────────
 * The agent may submit either an expression ("1 + 2 * 3", "GameObject.Find(...)") 
 * or a statement block ("var x = 5; Debug.Log(x);"). To give expressions a
 * return value without forcing the agent to write a method, we wrap the user
 * code in a generated static method and try two shapes:
 *   1. expression mode : `return (object)(<code>);`           — works for expressions
 *   2. statement mode  : `<code>; return null;`               — works for statement blocks
 * We attempt expression mode first; if Roslyn reports compile errors that look
 * like "not a valid expression" we fall back to statement mode. (Trying both and
 * picking the one that compiles is simpler and more robust than syntax-walking.)
 *
 * ─── Threading ──────────────────────────────────────────────────────────────
 * ExecuteCommand runs on the main thread (via EditorApplication.delayCall).
 * Emit + Assembly.Load + Invoke are all synchronous; no await is used anywhere,
 * so there is no deadlock surface (the old CSharpScript async caveat is gone).
 * The DispatchToMainThread 120s timeout still protects against runaway scripts.
 *
 * ─── State ──────────────────────────────────────────────────────────────────
 * Each eval is a fresh compilation + a fresh in-memory assembly. Locals do not
 * persist across calls. References are rebuilt every call so they pick up the
 * current AppDomain assemblies after a domain reload.
 *
 * Return value serialization: see SerializeReturnValue. Bounded + cycle-guarded
 * so a returned GameObject / scene graph can never produce an unbounded payload.
 *
 * License: MIT
 */

using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Emit;
using UnityEditor;
using UnityEngine;

namespace PiBridge
{
    internal static class RoslynEval
    {
        // Wrapper class name + entry method name we emit. Unique enough to avoid
        // colliding with user code; the assembly is throwaway (loaded anon).
        private const string WrapperTypeName = "__PiEvalWrapper";
        private const string EntryMethodName = "__PiEval";

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

        // Default imports — mirror what CSharpScript's WithImports gave us.
        private static readonly string[] _defaultUsings =
        {
            "System",
            "System.IO",
            "System.Linq",
            "System.Collections.Generic",
            "System.Reflection",
            "UnityEngine",
            "UnityEditor",
        };

        // User-project namespaces auto-discovered from loaded assemblies
        // (Assembly-CSharp, Assembly-CSharp-Editor, etc.). Cached on first use.
        // This lets eval reference game-defined types like RPG.PlayerController
        // without the agent having to fully-qualify them. Only non-system
        // assemblies are scanned (System/Unity/NUnit namespaces are already in
        // _defaultUsings or not useful to import wholesale).
        // Not cached: Assembly-CSharp may load after the first eval call (domain
        // reload timing), and caching a pre-load snapshot would miss game
        // namespaces permanently. GetTypes on user assemblies is cheap enough
        // to run per eval (few dozen types typically).
        private static string[] GetUsings()
        {
            var ns = new System.Collections.Generic.HashSet<string>();
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                string name = asm.GetName().Name;
                if (!name.StartsWith("Assembly-CSharp")) continue;
                try
                {
                    foreach (var t in asm.GetTypes())
                    {
                        string n = t.Namespace;
                        if (!string.IsNullOrEmpty(n) && n.Length <= 60) ns.Add(n);
                    }
                }
                catch { /* GetTypes can throw on some assemblies */ }
            }
            var result = new string[_defaultUsings.Length + ns.Count];
            _defaultUsings.CopyTo(result, 0);
            int i = _defaultUsings.Length;
            foreach (var n in ns) result[i++] = n;
            return result;
        }
        public static Response Run(string code)
        {
            List<MetadataReference> references;
            try
            {
                references = BuildReferences();
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
                            "If it still fails, the project may need an older Unity.",
                };
            }

            // Try expression mode first, then statement modes. Whichever compiles
            // and emits cleanly is the one we run. Three shapes, tried in order:
            //   1. expression      : `return (object)(<code>);`            — bare expression like `1+2`
            //   2. statement       : `<code>; return null;`                — pure statement block like `var x=5; Debug.Log(x);`
            //   3. trailing-return : `<prefix>; return (object)(<tail>);`  — `var x=...; <expr>` where the agent intends the
            //      last expression to be the return value (CSharpScript semantics). <tail> is detected via a real Roslyn
            //      syntax walk, so `;` inside string literals / for-headers is never split.
            //
            // If ALL fail, we return the expression-mode diagnostics (usually the most useful set for the agent,
            // since expression mode surfaces "not an expression" errors that pinpoint the real issue).
            CompilationResult exprResult = TryCompileAndEmit(references, code, EvalMode.Expression);
            if (exprResult.compileErrors != null)
            {
                // Expression mode had compile errors — try statement mode.
                CompilationResult stmtResult = TryCompileAndEmit(references, code, EvalMode.Statement);
                if (stmtResult.compileErrors != null)
                {
                    // Pure statement mode failed (e.g. last token is a bare expression the agent wants returned).
                    // Try trailing-return mode: promote the last expression statement to a return.
                    CompilationResult trailResult = TryCompileAndEmit(references, code, EvalMode.TrailingReturn);
                    if (trailResult.compileErrors != null)
                    {
                        // All three failed. Return expression-mode diagnostics (fall back to statement-mode
                        // if expression-mode produced zero errors for some reason but still didn't emit).
                        CompilationResult reported = exprResult.compileErrors.Count > 0 ? exprResult :
                                                    (stmtResult.compileErrors.Count > 0 ? stmtResult : trailResult);
                        return new Response
                        {
                            ok = false,
                            error = "Compilation error: " + string.Join("  |  ", reported.compileErrors.Select(FormatDiagnostic)),
                            result = new
                            {
                                kind = "compile",
                                diagnostics = reported.compileErrors.Select(FormatDiagnosticObject).ToArray(),
                                warnings = reported.warnings.Select(FormatDiagnosticObject).ToArray(),
                                mode = "expression+statement+trailing-return all failed",
                            },
                        };
                    }
                    return ExecuteEmitted(trailResult.assembly, trailResult.assemblyName);
                }
                // Statement mode compiled — run it.
                return ExecuteEmitted(stmtResult.assembly, stmtResult.assemblyName);
            }
            // Expression mode compiled — run it.
            return ExecuteEmitted(exprResult.assembly, exprResult.assemblyName);
        }

        // ─── Compilation ──────────────────────────────────────────────────────

        private struct CompilationResult
        {
            public List<Diagnostic> compileErrors; // non-null => compilation FAILED (do not use assembly)
            public List<Diagnostic> warnings;
            public Assembly assembly;              // non-null => compilation succeeded
            public string assemblyName;
        }

        private enum EvalMode { Expression, Statement, TrailingReturn }

        private static CompilationResult TryCompileAndEmit(
            List<MetadataReference> references, string code, EvalMode mode)
        {
            string assemblyName = "PiBridge.Eval." + Guid.NewGuid().ToString("N");
            string methodBody = BuildMethodBody(code, mode);
            if (methodBody == null)
            {
                // TrailingReturn mode could not identify a promotable trailing expression
                // (e.g. code is a single declaration, or has no trailing expression statement).
                // Synthesize a guaranteed-fail diagnostic so the caller falls through to the
                // next mode / final error reporting.
                return new CompilationResult
                {
                    compileErrors = new List<Diagnostic> { MakeError("PIEVAL_NO_TAIL", "No trailing expression to promote.") },
                    warnings = new List<Diagnostic>(),
                    assembly = null,
                    assemblyName = assemblyName,
                };
            }

            // Build the using block from default + auto-discovered user namespaces.
            // We emit usings in the SOURCE (not just CSharpCompilationOptions.usings)
            // because source-level usings are reliable across Roslyn versions; the
            // options.usings field has been observed to not import in some 3.x builds.
            var usings = GetUsings();
            var usingSb = new System.Text.StringBuilder();
            foreach (var u in usings) usingSb.Append("using ").Append(u).Append(";");
            string source =
                usingSb.ToString() +
                "namespace PiBridge.Dynamic { " +
                "  internal class " + WrapperTypeName + " { " +
                "    public static object " + EntryMethodName + "() { " +
                "      " + methodBody +
                "    } " +
                "  } " +
                "}";

            Microsoft.CodeAnalysis.SyntaxTree syntaxTree = CSharpSyntaxTree.ParseText(source);
            // Build options via the constructor — the With* chain (WithUsings/
            // WithAllowUnsafe/WithOverflowChecks) exists on Roslyn 3.x+ but the
            // constructor is the most portable shape across the v3.11/v4.0/v4.8
            // DLL sets we ship. allowUnsafe:true lets agent scripts use pointers
            // (e.g. NativeArray pinning); eval is already arbitrary code, so this
            // adds no new risk surface.
            var options = new CSharpCompilationOptions(
                outputKind: OutputKind.DynamicallyLinkedLibrary,
                checkOverflow: false,
                allowUnsafe: true,
                usings: GetUsings());

            CSharpCompilation compilation = CSharpCompilation.Create(
                assemblyName,
                new[] { syntaxTree },
                references,
                options);

            // Pre-check diagnostics so we get clean line/col on the USER code
            // (Emit also reports diagnostics, but ParseText line numbers map to
            // our wrapper; both map back to the same source, so this is fine).
            var allDiag = compilation.GetDiagnostics().ToList();
            var errors = allDiag.Where(d => d.Severity == DiagnosticSeverity.Error).ToList();
            var warnings = allDiag.Where(d => d.Severity == DiagnosticSeverity.Warning).ToList();
            if (errors.Count > 0)
            {
                return new CompilationResult
                {
                    compileErrors = errors,
                    warnings = warnings,
                    assembly = null,
                    assemblyName = assemblyName,
                };
            }

            // Emit to a MemoryStream, then load via Assembly.Load(byte[]).
            // Mono supports Assembly.Load(byte[]) natively — this is the whole
            // reason we avoid CSharpScript (which uses AssemblyLoadContext).
            using (var ms = new MemoryStream())
            {
                EmitResult emitResult;
                try
                {
                    emitResult = compilation.Emit(ms);
                }
                catch (Exception e)
                {
                    // Emit itself threw (rare — usually a reference problem).
                    return new CompilationResult
                    {
                        compileErrors = new List<Diagnostic>
                        {
                            MakeError("PIEVAL_EMIT", "Emit threw: " + e.GetType().Name + ": " + e.Message),
                        },
                        warnings = new List<Diagnostic>(),
                        assembly = null,
                        assemblyName = assemblyName,
                    };
                }

                if (!emitResult.Success)
                {
                    var emitErrors = emitResult.Diagnostics
                        .Where(d => d.Severity == DiagnosticSeverity.Error).ToList();
                    var emitWarnings = emitResult.Diagnostics
                        .Where(d => d.Severity == DiagnosticSeverity.Warning).ToList();
                    return new CompilationResult
                    {
                        compileErrors = emitErrors.Count > 0 ? emitErrors : errors,
                        warnings = emitWarnings.Count > 0 ? emitWarnings : warnings,
                        assembly = null,
                        assemblyName = assemblyName,
                    };
                }

                byte[] assemblyBytes = ms.ToArray();
                Assembly asm;
                try
                {
                    asm = Assembly.Load(assemblyBytes);
                }
                catch (Exception e)
                {
                    return new CompilationResult
                    {
                        compileErrors = new List<Diagnostic>
                        {
                            MakeError("PIEVAL_LOAD", "Assembly.Load threw: " + e.GetType().Name + ": " + e.Message),
                        },
                        warnings = new List<Diagnostic>(),
                        assembly = null,
                        assemblyName = assemblyName,
                    };
                }

                return new CompilationResult
                {
                    compileErrors = null,
                    warnings = warnings,
                    assembly = asm,
                    assemblyName = assemblyName,
                };
            }
        }

        // Build the generated method body for the given eval mode. Returns null if
        // TrailingReturn mode cannot identify a promotable trailing expression.
        //
        // Expression     : `return (object)(<code>);`
        // Statement      : ensure <code> ends with a statement terminator, then append `return null;`.
        //                  A missing ';' would merge the last user statement with `return null;` and break
        //                  compilation (e.g. `throw new X(...)` + `return null;`). Extra ';' on
        //                  already-terminated code is a harmless empty statement.
        // TrailingReturn : split <code> into <prefix> (all statements except the last expression statement)
        //                  and <tail> (the last expression statement's expression), then emit
        //                  `<prefix> return (object)(<tail>);`. This gives `var x = 5; x` the CSharpScript
        //                  semantics of returning `x`. The split is done via a Roslyn syntax walk so `;`
        //                  inside string literals, char literals, or for-headers is never mistaken for a
        //                  statement boundary.
        private static string BuildMethodBody(string code, EvalMode mode)
        {
            string trimmed = code.TrimEnd();
            if (mode == EvalMode.Expression)
                return "return (object)(" + code + ");";

            if (mode == EvalMode.Statement)
            {
                string body = (trimmed.EndsWith(";") || trimmed.EndsWith("}")) ? code : code + ";";
                return body + "\nreturn null;";
            }

            // TrailingReturn mode.
            int tailStart;
            string tail = ExtractTrailingExpression(code, out tailStart);
            if (tail == null) return null;
            // Slice the original code at the trailing expression's start so preceding statements
            // and whitespace are preserved verbatim, then append the return.
            string prefix = code.Substring(0, tailStart);
            string pt = prefix.TrimEnd();
            if (!pt.EndsWith(";") && !pt.EndsWith("}")) prefix = prefix + ";";
            return prefix + " return (object)(" + tail + ");";
        }

        // Parse <code> (wrapped in a dummy method body for valid statement context) and return
        // the source text of the LAST ExpressionStatement's expression, or null if the code has
        // no trailing expression statement (e.g. it ends in a declaration, a block, or nothing).
        // <code> is wrapped rather than parsed as a CompilationUnit because bare statements as a
        // top-level program need C# 9+ and produce a slow, unstable recovery tree; wrapping gives
        // a clean BlockSyntax whose statement boundaries follow the real C# grammar (so `;` inside
        // `for(int i=0;i<10;i++)` is never mistaken for a statement boundary).
        // tailStart receives the 0-based offset of the trailing expression within the ORIGINAL
        // user code (derived by subtracting the fixed wrapped-method prefix length from the
        // expression's syntax span start).
        private static string ExtractTrailingExpression(string code, out int tailStart)
        {
            tailStart = -1;
            const string wrappedPrefix = "class __C { void __M() { ";
            string wrapped = wrappedPrefix + code + " } }";
            SyntaxTree tree = CSharpSyntaxTree.ParseText(wrapped);
            SyntaxNode root = tree.GetRoot();
            BlockSyntax block = root.DescendantNodes().OfType<BlockSyntax>().FirstOrDefault();
            if (block == null) return null;
            var stmts = block.Statements;
            if (stmts.Count == 0) return null;
            StatementSyntax last = stmts[stmts.Count - 1];
            if (!(last is ExpressionStatementSyntax es)) return null;
            tailStart = es.Expression.SpanStart - wrappedPrefix.Length;
            return es.Expression.ToString();
        }

        // Fabricate a DiagnosticDescriptor for emit/load failures (which aren't
        // syntax errors) so they flow through the same formatting pipeline as
        // real Roslyn diagnostics. DiagnosticDescriptor is sealed, so we
        // construct it directly rather than subclassing.
        private static Diagnostic MakeError(string id, string message)
        {
            var descriptor = new DiagnosticDescriptor(
                id: id,
                title: "PiBridge eval",
                messageFormat: message,
                category: "PiBridge",
                defaultSeverity: DiagnosticSeverity.Error,
                isEnabledByDefault: true);
            return Diagnostic.Create(descriptor, Location.None);
        }

        // ─── Execution ────────────────────────────────────────────────────────

        private static Response ExecuteEmitted(Assembly asm, string assemblyName)
        {
            Type wrapperType = asm.GetType("PiBridge.Dynamic." + WrapperTypeName);
            if (wrapperType == null)
            {
                return new Response
                {
                    ok = false,
                    error = "Internal eval error: wrapper type not found in emitted assembly.",
                };
            }
            MethodInfo entry = wrapperType.GetMethod(EntryMethodName, BindingFlags.Public | BindingFlags.Static);
            if (entry == null)
            {
                return new Response
                {
                    ok = false,
                    error = "Internal eval error: entry method not found on wrapper type.",
                };
            }

            object returnValue;
            try
            {
                returnValue = entry.Invoke(null, null);
            }
            catch (TargetInvocationException tie)
            {
                // The user's code threw. Unwrap to the real exception for a clean message.
                Exception real = tie.InnerException ?? tie;
                return new Response
                {
                    ok = false,
                    error = "eval threw " + real.GetType().Name + ": " + real.Message,
                    result = new { kind = "runtime", type = real.GetType().FullName, stack = Truncate(real.StackTrace, 4000) },
                };
            }
            catch (Exception e)
            {
                return new Response
                {
                    ok = false,
                    error = "eval invocation failed: " + e.GetType().Name + ": " + e.Message,
                    result = new { kind = "runtime", type = e.GetType().FullName, stack = Truncate(e.StackTrace, 4000) },
                };
            }

            return new Response
            {
                ok = true,
                result = new
                {
                    value = SerializeReturnValue(returnValue, new HashSet<object>(ReferenceComparer)),
                    type = returnValue?.GetType().FullName,
                    hasReturnValue = returnValue != null,
                    mode = "compiler-api",
                },
            };
        }

        // ─── References ───────────────────────────────────────────────────────
        //
        // Build MetadataReferences from the currently-loaded assemblies. The
        // Editor AppDomain at eval time has UnityEngine/UnityEditor, all package
        // and user assemblies loaded — so the script can reference any of them.
        // Filtering: skip dynamic assemblies (no Location) and assemblies whose
        // Location throws or is empty (some Mono reflection-emit assemblies).
        private static List<MetadataReference> BuildReferences()
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
            return refs;
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

            // Primitives, string, decimal: safe passthrough (SimpleJson handles these directly).
            if (t == typeof(string) || t.IsPrimitive || t == typeof(decimal))
                return value;

            // Enums: SimpleJson does NOT recognize enums and would reflect over their static
            // members (every enum constant is a public static field of the same enum type,
            // causing infinite recursion). Convert to a small {name, value} dict so the agent
            // gets both the symbolic name and the underlying integer.
            if (t.IsEnum)
                return new Dictionary<string, object>
                {
                    { "name", Enum.GetName(t, value) },
                    { "value", Convert.ToInt64(value) },
                };

            // Common Unity value types (Vector3, Color, Rect, ...): convert to a
            // dictionary of their primitive public fields ourselves. We must NOT
            // passthrough the raw value to SimpleJson — SimpleJson's object branch
            // reflects public PROPERTIES too, and Vector3.normalized returns a
            // Vector3, causing infinite recursion (stack overflow / hang).
            if (IsUnityValueType(t))
            {
                var dict = new Dictionary<string, object>();
                foreach (var field in t.GetFields(BindingFlags.Public | BindingFlags.Instance))
                {
                    dict[field.Name] = SerializeReturnValue(field.GetValue(value), visited, depth + 1);
                }
                return dict;
            }

            // UnityEngine.Object derivatives (GameObject, Component, Material, ...) must NOT
            // be walked as IEnumerable even when they implement it (Transform enumerates
            // children, Material enumerates nothing useful). Their property graphs are huge
            // and many getters throw on the wrong thread / unloaded state. Capsule them.
            if (typeof(UnityEngine.Object).IsAssignableFrom(t))
                return Capsule(value, null);

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
