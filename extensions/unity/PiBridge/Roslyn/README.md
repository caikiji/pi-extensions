# Roslyn — C# scripting DLLs for PiBridge `eval`

These DLLs let PiBridge's `eval` command compile and execute arbitrary C#
snippets at runtime via `Microsoft.CodeAnalysis.CSharp.Scripting.CSharpScript`.

## Version matrix

| Folder    | Roslyn ver | Target Unity versions         | C# level | lib TFM shipped |
|-----------|-----------|-------------------------------|----------|-----------------|
| v3.11.0   | 3.11.0    | Unity 2019.4 / 2020.3 LTS     | C# 7.3/8 | netstandard2.0  |
| v4.0.1    | 4.0.1     | Unity 2021.3 / 2022.3 LTS     | C# 9.0   | netstandard2.0  |
| v4.8.0    | 4.8.0     | Unity 6 (6000.x) / Tuanjie 6  | C# 10+   | netstandard2.0  |

`unity_install_bridge` reads the project's `ProjectVersion.txt` and copies the
matching folder into `Assets/Editor/PiBridge/Roslyn/`. If no folder matches the
Unity version, PiBridge.cs still compiles (the `eval` case falls back to the
reflection-based `EvalExpression` with a clear error pointing here).

## Why these DLLs (and not others)

Only the netstandard2.0 variants are shipped. Only DLLs that are NOT already part
of Unity's Mono BCL are included (Microsoft.CodeAnalysis.*, System.Collections.Immutable,
System.Reflection.Metadata, System.Runtime.CompilerServices.Unsafe, System.Memory,
System.Buffers, System.Threading.Tasks.Extensions, System.Text.Encoding.CodePages)
to avoid type-identity conflicts with the Editor's own runtime.

Version alignment is critical: each Roslyn version's `Microsoft.CodeAnalysis.dll` pins
the assembly-reference versions of its support DLLs, and Unity's Mono runtime does
strict version binding (a mismatch raises `FileLoadException` at eval time). The
shipped `System.Runtime.CompilerServices.Unsafe.dll` is therefore per-version:
  v3.11.0 / v4.0.1 → pkg 5.0.0  (asm 5.0.0.0) — matches Roslyn's ref to v5.0.0.0
  v4.8.0           → pkg 6.0.0  (asm 6.0.0.0) — matches Roslyn's ref to v6.0.0.0
and `System.Collections.Immutable`/`System.Reflection.Metadata`/`System.Text.Encoding.CodePages`
follow suit (v5.0.0.0 for 3.11/4.0.1, v7.0.0.0 for 4.8.0). The `copy_version` script
below picks the version dir whose netstandard2.0 DLL's assembly version matches Roslyn's
reference — re-verify with a Cecil probe if you regenerate.

## Source / reproducibility

All DLLs are the official Microsoft NuGet builds (PublicKeyToken
`31bf3856ad364e35`), netstandard2.0 target, extracted with `dotnet restore`.
To regenerate a set:

```bash
mkdir /tmp/r && cd /tmp/r
cat > r.csproj <<'X'
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>netstandard2.0</TargetFramework><NoBuild>true</NoBuild></PropertyGroup>
  <ItemGroup><PackageReference Include="Microsoft.CodeAnalysis.CSharp.Scripting" Version="4.0.1"/></ItemGroup>
</Project>
X
dotnet restore r.csproj --packages /tmp/n
# then copy lib/netstandard2.0/*.dll from each resolved package
```

## Origin

Downloaded from https://nuget.org — packages: Microsoft.CodeAnalysis.CSharp.Scripting
(and its transitive dependencies). License: MIT (Microsoft.CodeAnalysis) / the
respective per-DLL licenses. No modification.
