import Docker from 'dockerode';
import { PassThrough } from 'stream';

export const docker = new Docker();

/** Volume name for a conversation's persistent workspace. */
export function convVolumeName(convId: string): string {
  // Sanitise convId → only alphanumeric and dash (Docker volume name rules).
  return `everything-workspace-${convId.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`;
}

export async function createAndStartContainer(image: string, name: string): Promise<string> {
  const container = await docker.createContainer({
    Image: image,
    name,
    Tty: false,
    // No network access from the sandbox container itself.
    // Playwright browsing uses a separate sidecar (playwright-mcp) with controlled HTTP.
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

/**
 * Mount a named volume for a conversation into a running container so that
 * `/workspace` is backed by a persistent Docker volume for the life of the
 * conversation's sandbox session.
 *
 * We cannot mount volumes to an already-running container via the Docker API
 * directly (Docker doesn't support hot-attaching volumes). Instead the pattern
 * is: copy files into a bind-mountable path using `exec` into the container,
 * then ensure the named volume is created. The actual persistent workspace is
 * at `/workspace/<convId>/` *inside* the container's ephemeral filesystem —
 * this is sufficient because the container is never reset between calls in the
 * same conversation (sticky lease), and is wiped as a whole on lease release.
 *
 * For a future migration to volume-per-conversation on fresh containers,
 * `docker.createContainer` would include `HostConfig.Binds`.
 *
 * For now: we create the per-conversation subdirectory and return its path.
 */
export async function ensureConvWorkspace(containerId: string, convId: string): Promise<string> {
  // Sanitise convId for use as a directory name.
  const safeConvId = convId.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const workspacePath = `/workspace/${safeConvId}`;
  await execInContainer(containerId, `mkdir -p ${workspacePath}`, 5_000);
  return workspacePath;
}

/**
 * Prune the conversation's workspace directory from the container.
 * Called when the lease is released (idle timeout or explicit release).
 * Non-fatal if the container is already gone.
 */
export async function pruneConvVolume(convId: string): Promise<void> {
  // Volume name kept for potential future use with actual named volumes.
  const name = convVolumeName(convId);
  try {
    const volume = docker.getVolume(name);
    await volume.remove();
    console.log(`[docker] pruned volume ${name}`);
  } catch {
    // Volume may not exist — this is fine.
  }
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
  // Wipe entire workspace and clear action log — safe to reassign to a new conversation.
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
