using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace PalServerConsole.PortableLauncher
{
    public static class Program
    {
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int MessageBox(IntPtr window, string text, string caption, uint type);

        private static int Main(string[] args)
        {
            string packageRoot = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(
                Path.DirectorySeparatorChar,
                Path.AltDirectorySeparatorChar
            );
            string target = Path.Combine(packageRoot, "Program", "PalServerConsole.exe");
            if (!File.Exists(target))
            {
                return Fail(
                    "Program\\PalServerConsole.exe is missing. Extract the complete release package before starting."
                );
            }

            try
            {
                ProcessStartInfo startInfo = new ProcessStartInfo
                {
                    FileName = target,
                    Arguments = JoinArguments(args),
                    WorkingDirectory = packageRoot,
                    UseShellExecute = false,
                    CreateNoWindow = false,
                };
                startInfo.EnvironmentVariables["PALSERVER_CONSOLE_DATA"] = Path.Combine(packageRoot, "data");

                using (Process child = Process.Start(startInfo))
                {
                    if (child == null)
                    {
                        return Fail("Windows did not start Program\\PalServerConsole.exe.");
                    }
                    child.WaitForExit();
                    if (child.ExitCode != 0 && !Console.IsOutputRedirected)
                    {
                        MessageBox(
                            IntPtr.Zero,
                            "PalServerConsole exited with code " + child.ExitCode +
                                ". Review the console error details.",
                            "PalServerConsole",
                            0x10
                        );
                    }
                    return child.ExitCode;
                }
            }
            catch (Exception error)
            {
                return Fail(error.ToString());
            }
        }

        private static int Fail(string message)
        {
            Console.Error.WriteLine(message);
            if (!Console.IsErrorRedirected)
            {
                MessageBox(IntPtr.Zero, message, "PalServerConsole startup failed", 0x10);
            }
            return 1;
        }

        private static string JoinArguments(string[] args)
        {
            StringBuilder commandLine = new StringBuilder();
            foreach (string argument in args)
            {
                if (commandLine.Length > 0)
                {
                    commandLine.Append(' ');
                }
                commandLine.Append(QuoteArgument(argument));
            }
            return commandLine.ToString();
        }

        private static string QuoteArgument(string argument)
        {
            if (
                argument.Length > 0 &&
                argument.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0
            )
            {
                return argument;
            }

            StringBuilder quoted = new StringBuilder();
            quoted.Append('"');
            int backslashes = 0;
            foreach (char current in argument)
            {
                if (current == '\\')
                {
                    backslashes += 1;
                    continue;
                }
                if (current == '"')
                {
                    quoted.Append('\\', backslashes * 2 + 1);
                    quoted.Append('"');
                    backslashes = 0;
                    continue;
                }
                quoted.Append('\\', backslashes);
                backslashes = 0;
                quoted.Append(current);
            }
            quoted.Append('\\', backslashes * 2);
            quoted.Append('"');
            return quoted.ToString();
        }
    }
}
