import Docker from 'dockerode';
import { PassThrough } from 'stream';

export const docker = new Docker();

export async function createAndStartContainer(image: string, name: string): Promise<string> {
  const container = await docker.createContainer({
    Image: image,
    name,
    Tty: false,
    // Whitelist-only: no network access from the sandbox container itself.
    // The orchestrator (Phase 3) will provide a controlled fetch tool instead.
    NetworkDisabled: true,
    HostConfig: {
      // Resource caps — the Pi has limited RAM, Skarpa Bytom needs headroom.
      Memory: 512 * 1024 * 1024, // 512 MB
      CpuShares: 512,            // ~50% weight relative to other containers
      AutoRemove: false,         // we manage lifecycle manually
    },
  });
  await container.start();
  return container.id;
}

export async function execInContainer(
  containerId: string,
  command: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const container = docker.getContainer(containerId);

  // Log the command to the append-only action log before executing.
  // This runs even if the main command times out or errors.
  const logEntry = `[${new Date().toISOString()}] $ ${command}\n`;
  const logExec = await container.exec({
    Cmd: ['bash', '-c', `echo ${JSON.stringify(logEntry)} >> /var/log/sandbox-actions.log`],
    AttachStdout: false,
    AttachStderr: false,
  });
  const logStream = await logExec.start({ hijack: false, stdin: false });
  logStream.destroy();

  const exec = await container.exec({
    Cmd: ['bash', '-c', command],
    AttachStdout: true,
    AttachStderr: true,
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);

    exec.start({ hijack: true, stdin: false }, (err, stream) => {
      if (err || !stream) {
        clearTimeout(timer);
        reject(err ?? new Error('No stream returned from exec'));
        return;
      }

      const stdout = new PassThrough();
      const stderr = new PassThrough();
      docker.modem.demuxStream(stream, stdout, stderr);

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      stream.on('end', () => {
        clearTimeout(timer);
        exec.inspect((inspectErr, data) => {
          if (inspectErr || !data) {
            resolve({
              stdout: Buffer.concat(stdoutChunks).toString('utf8'),
              stderr: Buffer.concat(stderrChunks).toString('utf8'),
              exitCode: -1,
            });
            return;
          }
          resolve({
            stdout: Buffer.concat(stdoutChunks).toString('utf8'),
            stderr: Buffer.concat(stderrChunks).toString('utf8'),
            exitCode: data.ExitCode ?? -1,
          });
        });
      });

      stream.on('error', (streamErr) => {
        clearTimeout(timer);
        reject(streamErr);
      });
    });
  });
}

export async function resetContainer(containerId: string): Promise<void> {
  // Wipe workspace and clear action log — safe to return to pool
  await execInContainer(
    containerId,
    'rm -rf /workspace/* /workspace/.[!.]* 2>/dev/null; truncate -s 0 /var/log/sandbox-actions.log',
    10_000,
  );
}

export async function removeContainer(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);
  try {
    await container.stop({ t: 5 });
  } catch {
    // Already stopped — fine
  }
  await container.remove({ force: true });
}
