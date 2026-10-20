import net from "node:net";

const BACKUP_CONTROL_SOCKET = "/run/readypackets/backup-control.sock";

/**
 * Invoke a fixed allowlisted action on the root-owned backup controller. The
 * portal never gets a shell, sudo, path argument, or controller credential.
 */
export function runBackupControl(args: string[], stdin = ""): Promise<string> {
  const [action, ...actionArgs] = args;
  if (!action) return Promise.reject(new Error("Backup control action is required."));

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: BACKUP_CONTROL_SOCKET });
    let response = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Backup control request timed out."));
    }, 30_000);

    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ action, args: actionArgs, stdin })}\n`);
    });
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.includes("\n")) socket.end();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("close", () => {
      clearTimeout(timer);
      try {
        const payload = JSON.parse(response.trim()) as { ok?: boolean; output?: string; error?: string };
        if (!payload.ok) {
          reject(new Error(payload.error ?? "Backup control rejected the request."));
          return;
        }
        resolve((payload.output ?? "").trim());
      } catch {
        reject(new Error("Backup control returned an invalid response."));
      }
    });
  });
}

export function parseBackupControl(output: string): Record<string, string> {
  return Object.fromEntries(
    output
      .split("\n")
      .map((line) => line.split("=", 2))
      .filter(([key, value]) => Boolean(key) && value !== undefined),
  );
}
