namespace PiBridge
{
    // Response envelope returned by every bridge command.
    internal class Response
    {
        public bool ok;
        public object result;
        public string error;
        public int durationMs;
    }
}
