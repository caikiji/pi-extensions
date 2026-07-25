using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace PiBridge
{
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
            if (t.IsPrimitive || t == typeof(decimal)) { sb.Append(Convert.ToString(obj, CultureInfo.InvariantCulture)); return; }
            if (t.IsArray || t.GetInterface(nameof(IEnumerable)) != null)
            {
                sb.Append('[');
                bool first = true;
                foreach (var item in (IEnumerable)obj)
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
                    return double.Parse(num, CultureInfo.InvariantCulture);
                return long.Parse(num, CultureInfo.InvariantCulture);
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
