using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;

internal sealed class AthenaLauncher : Form
{
    private readonly string appDir;
    private readonly string serverPath;
    private readonly Label status;
    private readonly System.Windows.Forms.Timer timer;
    private readonly Button openButton;
    private readonly string logPath;
    private Process server;
    private Process ollamaServer;
    private bool openedBrowser;
    private DateTime startupDeadline;
    private string shutdownToken;
    private static readonly object LogLock = new object();

    private AthenaLauncher()
    {
        appDir = AppDomain.CurrentDomain.BaseDirectory;
        serverPath = Path.Combine(appDir, "server.py");
        string logDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ATHENA-PaperDesk");
        logPath = Path.Combine(logDir, "launcher.log");
        Text = "ATHENA Paper Desk";
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = true;
        ClientSize = new Size(420, 150);

        status = new Label();
        status.Text = "Starting ATHENA and its local AI…";
        status.AutoSize = false;
        status.Location = new Point(18, 18);
        status.Size = new Size(384, 54);
        status.Font = new Font("Segoe UI", 10F);
        Controls.Add(status);

        openButton = new Button();
        openButton.Text = "Open ATHENA";
        openButton.Location = new Point(18, 88);
        openButton.Size = new Size(130, 36);
        openButton.Enabled = false;
        openButton.Click += delegate { OpenBrowser(); };
        Controls.Add(openButton);

        Button close = new Button();
        close.Text = "Stop server and exit";
        close.Location = new Point(250, 88);
        close.Size = new Size(152, 36);
        close.Click += delegate { Close(); };
        Controls.Add(close);

        timer = new System.Windows.Forms.Timer();
        timer.Interval = 750;
        timer.Tick += delegate
        {
            if (IsServerReady())
            {
                openButton.Enabled = true;
                if (!openedBrowser) OpenBrowser();
                if (!openedBrowser)
                {
                    timer.Stop();
                    return;
                }

                bool modelInstalled;
                if (IsOllamaApiReady(out modelInstalled))
                {
                    timer.Stop();
                    status.Text = modelInstalled
                        ? "ATHENA and its local AI are ready. Keep this window open while using the desk."
                        : "ATHENA is ready, but gemma3:1b is missing. See the Copilot status and launcher.log.";
                    return;
                }

                if (ollamaServer == null || ollamaServer.HasExited)
                {
                    if (ollamaServer != null)
                        AppendLog(logPath, "Ollama server process exited during startup (exit code " + ollamaServer.ExitCode + ").");
                    timer.Stop();
                    status.Text = "ATHENA is ready, but Ollama did not start. Check launcher.log; Copilot will use its fallback.";
                    return;
                }

                if (DateTime.UtcNow >= startupDeadline)
                {
                    AppendLog(logPath, "Ollama API did not become ready before the startup deadline.");
                    timer.Stop();
                    status.Text = "ATHENA is ready, but Ollama did not respond in time. Check launcher.log.";
                    return;
                }

                status.Text = "ATHENA is ready. Waiting for Ollama to start in the background…";
                return;
            }

            if (server != null && server.HasExited)
            {
                timer.Stop();
                status.Text = "The local server stopped during startup. Check Python setup and launcher.log in %LOCALAPPDATA%\\ATHENA-PaperDesk.";
                return;
            }

            if (DateTime.UtcNow >= startupDeadline)
            {
                timer.Stop();
                status.Text = "ATHENA did not become ready within 30 seconds. Check launcher.log and Python package setup.";
                return;
            }
        };
        Shown += delegate { StartOrReuseServer(); };
        FormClosing += delegate { StopOwnedServer(); };
    }

    private void StartOrReuseServer()
    {
        if (!File.Exists(serverPath))
        {
            status.Text = "server.py was not found beside this launcher. Keep the EXE in the ATHENA app folder.";
            return;
        }

        try { Directory.CreateDirectory(Path.GetDirectoryName(logPath)); }
        catch (Exception ex)
        {
            status.Text = "Cannot create the launcher log folder in %LOCALAPPDATA%\\ATHENA-PaperDesk: " + ex.Message;
            return;
        }
        AppendLog(logPath, "Starting ATHENA launcher.");
        startupDeadline = DateTime.UtcNow.AddSeconds(30);
        StartOllamaInBackground();

        if (IsServerReady())
        {
            status.Text = "ATHENA server is already running. Checking the local AI…";
            openedBrowser = false;
            timer.Start();
            return;
        }

        foreach (string executable in PythonCandidates())
        {
            try
            {
                ProcessStartInfo info = new ProcessStartInfo();
                info.FileName = executable;
                info.Arguments = (String.Equals(Path.GetFileName(executable), "py.exe", StringComparison.OrdinalIgnoreCase) ? "-3 " : "") + "\"" + serverPath + "\"";
                info.WorkingDirectory = appDir;
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                info.WindowStyle = ProcessWindowStyle.Hidden;
                info.RedirectStandardOutput = true;
                info.RedirectStandardError = true;
                shutdownToken = Guid.NewGuid().ToString("N");
                info.EnvironmentVariables["ATHENA_LAUNCHER_SHUTDOWN_TOKEN"] = shutdownToken;
                server = new Process();
                server.StartInfo = info;
                server.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { AppendLog(logPath, e.Data); };
                server.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { AppendLog(logPath, e.Data); };
                server.Start();
                server.BeginOutputReadLine();
                server.BeginErrorReadLine();
                startupDeadline = DateTime.UtcNow.AddSeconds(30);
                timer.Start();
                return;
            }
            catch (Exception ex)
            {
                AppendLog(logPath, executable + ": " + ex.Message);
                if (server != null)
                {
                    try { if (!server.HasExited) server.Kill(); } catch { }
                    try { server.Dispose(); } catch { }
                    server = null;
                }
            }
        }

        status.Text = "Python 3 was not found. Install Python 3.9+ and the requirements from README.md, then reopen this launcher.";
    }

    private void StartOllamaInBackground()
    {
        bool modelInstalled;
        for (int attempt = 0; attempt < 4; attempt++)
        {
            if (IsOllamaApiReady(out modelInstalled))
            {
                AppendLog(logPath, modelInstalled
                    ? "Ollama is already running with gemma3:1b available."
                    : "Ollama is already running, but gemma3:1b was not found.");
                return;
            }
            Thread.Sleep(350);
        }

        string executable = FindOllamaExecutable();
        if (String.IsNullOrEmpty(executable))
        {
            AppendLog(logPath, "ollama.exe was not found in the standard install folders or PATH.");
            return;
        }

        try
        {
            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = executable;
            info.Arguments = "serve";
            info.WorkingDirectory = Path.GetDirectoryName(executable);
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.WindowStyle = ProcessWindowStyle.Hidden;
            ollamaServer = new Process();
            ollamaServer.StartInfo = info;
            ollamaServer.Start();
            AppendLog(logPath, "Started Ollama in the background (PID " + ollamaServer.Id + ").");
        }
        catch (Exception ex)
        {
            AppendLog(logPath, "Could not start Ollama: " + ex.Message);
            if (ollamaServer != null)
            {
                try { ollamaServer.Dispose(); } catch { }
                ollamaServer = null;
            }
        }
    }

    private static string FindOllamaExecutable()
    {
        List<string> candidates = new List<string>();
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        string programFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        candidates.Add(Path.Combine(local, "Programs", "Ollama", "ollama.exe"));
        candidates.Add(Path.Combine(local, "Ollama", "ollama.exe"));
        candidates.Add(Path.Combine(programFiles, "Ollama", "ollama.exe"));
        candidates.Add(Path.Combine(programFilesX86, "Ollama", "ollama.exe"));

        string[] pathValues = {
            Environment.GetEnvironmentVariable("PATH"),
            Environment.GetEnvironmentVariable("PATH", EnvironmentVariableTarget.User),
            Environment.GetEnvironmentVariable("PATH", EnvironmentVariableTarget.Machine)
        };
        foreach (string value in pathValues)
        {
            if (String.IsNullOrEmpty(value)) continue;
            foreach (string directory in value.Split(Path.PathSeparator))
            {
                if (!String.IsNullOrWhiteSpace(directory))
                    candidates.Add(Path.Combine(directory.Trim(), "ollama.exe"));
            }
        }

        string[] registryKeys = {
            @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\ollama.exe",
            @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{44E83376-CE68-45EB-8FC1-393500EB558C}_is1"
        };
        foreach (string registryPath in registryKeys)
        {
            foreach (Microsoft.Win32.RegistryKey root in new Microsoft.Win32.RegistryKey[] {
                Microsoft.Win32.Registry.CurrentUser, Microsoft.Win32.Registry.LocalMachine })
            {
                try
                {
                    using (Microsoft.Win32.RegistryKey key = root.OpenSubKey(registryPath))
                    {
                        if (key == null) continue;
                        string registeredPath = key.GetValue(null) as string;
                        if (String.IsNullOrEmpty(registeredPath)) registeredPath = key.GetValue("InstallLocation") as string;
                        if (String.IsNullOrEmpty(registeredPath)) continue;
                        if (String.Equals(Path.GetFileName(registeredPath), "ollama.exe", StringComparison.OrdinalIgnoreCase))
                            candidates.Add(registeredPath);
                        else
                            candidates.Add(Path.Combine(registeredPath, "ollama.exe"));
                    }
                }
                catch { }
            }
        }

        foreach (string candidate in candidates)
        {
            try { if (File.Exists(candidate)) return Path.GetFullPath(candidate); }
            catch { }
        }
        return null;
    }

    private static bool IsOllamaApiReady(out bool modelInstalled)
    {
        modelInstalled = false;
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:11434/api/tags");
            request.Method = "GET";
            request.Timeout = 700;
            request.ReadWriteTimeout = 700;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            {
                if (response.StatusCode != HttpStatusCode.OK) return false;
                using (StreamReader reader = new StreamReader(response.GetResponseStream()))
                {
                    string body = reader.ReadToEnd();
                    modelInstalled = body.IndexOf("\"gemma3:1b\"", StringComparison.OrdinalIgnoreCase) >= 0;
                    return true;
                }
            }
        }
        catch { return false; }
    }

    private static string[] PythonCandidates()
    {
        System.Collections.Generic.List<string> paths = new System.Collections.Generic.List<string>();
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string[] patterns = {
            Path.Combine(local, "Python", "pythoncore-*"),
            Path.Combine(local, "Programs", "Python", "Python*"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Python*")
        };
        foreach (string pattern in patterns)
        {
            try
            {
                string parent = Path.GetDirectoryName(pattern);
                string leaf = Path.GetFileName(pattern);
                foreach (string dir in Directory.GetDirectories(parent, leaf))
                {
                    string python = Path.Combine(dir, "python.exe");
                    if (File.Exists(python)) paths.Add(python);
                }
            }
            catch { }
        }
        paths.Add("py.exe");
        paths.Add("python.exe");
        return paths.ToArray();
    }

    private static void AppendLog(string path, string line)
    {
        if (String.IsNullOrEmpty(line)) return;
        try
        {
            lock (LogLock)
                File.AppendAllText(path, DateTime.Now.ToString("s") + " " + line + Environment.NewLine);
        }
        catch { }
    }

    private bool IsServerReady()
    {
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:8765/api/health");
            request.Method = "GET";
            request.Timeout = 700;
            request.ReadWriteTimeout = 700;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            {
                if (response.StatusCode != HttpStatusCode.OK) return false;
                using (StreamReader reader = new StreamReader(response.GetResponseStream()))
                {
                    string body = reader.ReadToEnd();
                    return body.IndexOf("\"ok\": true", StringComparison.Ordinal) >= 0
                        && body.IndexOf("\"service\": \"athena-paper-desk\"", StringComparison.Ordinal) >= 0;
                }
            }
        }
        catch { return false; }
    }

    private void OpenBrowser()
    {
        try
        {
            ProcessStartInfo info = new ProcessStartInfo("http://127.0.0.1:8765/");
            info.UseShellExecute = true;
            Process.Start(info);
            openedBrowser = true;
        }
        catch (Exception ex)
        {
            status.Text = "Server is running, but the browser could not be opened: " + ex.Message;
        }
    }

    private void StopOwnedServer()
    {
        timer.Stop();
        try
        {
            if (server != null && !server.HasExited)
            {
                if (!String.IsNullOrEmpty(shutdownToken))
                {
                    try
                    {
                        HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:8765/api/launcher/shutdown");
                        request.Method = "POST";
                        request.Timeout = 1500;
                        request.ReadWriteTimeout = 1500;
                        request.Headers["X-Athena-Launcher-Token"] = shutdownToken;
                        using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                            AppendLog(logPath, "Requested graceful server shutdown (HTTP " + (int)response.StatusCode + ").");
                    }
                    catch (Exception ex) { AppendLog(logPath, "Graceful shutdown request failed: " + ex.Message); }
                }

                if (!server.WaitForExit(5000))
                {
                    AppendLog(logPath, "Server did not stop within 5 seconds; terminating the launcher-owned process.");
                    server.Kill();
                    server.WaitForExit(3000);
                }
            }
            if (server != null) server.Dispose();
        }
        catch (Exception ex) { AppendLog(logPath, "Server cleanup failed: " + ex.Message); }

        StopOllamaServer();
    }

    private void StopOllamaServer()
    {
        // Ollama exposes no local shutdown endpoint. Stop its server process after
        // ATHENA has shut down, whether this launcher started it or reused it.
        Process[] candidates = new Process[0];
        try { candidates = Process.GetProcessesByName("ollama"); }
        catch (Exception ex) { AppendLog(logPath, "Could not enumerate Ollama processes: " + ex.Message); }

        bool found = false;
        foreach (Process candidate in candidates)
        {
            found = true;
            try
            {
                if (candidate.HasExited) continue;
                AppendLog(logPath, "Stopping Ollama process (PID " + candidate.Id + ") after ATHENA shutdown.");
                candidate.Kill();
                if (candidate.WaitForExit(5000))
                    AppendLog(logPath, "Ollama process stopped.");
                else
                    AppendLog(logPath, "Ollama process did not exit within 5 seconds.");
            }
            catch (Exception ex) { AppendLog(logPath, "Could not stop Ollama process: " + ex.Message); }
            finally { candidate.Dispose(); }
        }
        if (!found) AppendLog(logPath, "No Ollama server process was running at ATHENA shutdown.");

        if (ollamaServer != null)
        {
            try { ollamaServer.Dispose(); } catch { }
            ollamaServer = null;
        }
    }

    [STAThread]
    private static void Main()
    {
        bool createdNew;
        using (Mutex mutex = new Mutex(true, @"Local\ATHENA-PaperDesk-Launcher", out createdNew))
        {
            if (!createdNew) return;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new AthenaLauncher());
        }
    }
}
