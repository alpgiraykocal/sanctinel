'use strict';

/*
 * How much memory this process is actually allowed, and whether a background
 * refresh will fit inside what is left.
 *
 * This exists because of a crash loop that took the deployment down. The daily
 * GitHub Action normally keeps the bundled snapshot under the refresh TTL, so
 * the runtime fetch is a fallback that almost never runs. When the Action had
 * not published for a day, every cold boot took the fallback — and the fallback
 * does not fit:
 *
 *   main process, snapshot parsed + index built   ~420MB RSS
 *   refresh worker, capped at                      300MB old generation
 *   Render free tier, total                        512MB
 *
 * So the container was OOM-killed mid-refresh, restarted, found the same stale
 * cache, started the same refresh, and died again. Nothing recovered it,
 * because the thing that would have recovered it is what was doing the killing.
 * `/healthz` answering 200 during boot — added so a platform health check would
 * not kill the container mid-load — meant the platform kept the loop going.
 *
 * The honest behaviour on an instance this size is to decline the refresh and
 * say the data is stale, which the UI already knows how to display. Stale data
 * that is clearly labelled beats a screening tool that is not there at all.
 */

const fs = require('fs');
const os = require('os');

const MB = 1048576;

/*
 * The container's memory ceiling in bytes, or null when it cannot be read.
 *
 * cgroup v2 first (`memory.max`), then v1 (`memory.limit_in_bytes`), then the
 * host total. The v1 file reports an enormous sentinel when unlimited, so
 * anything at or above the host's own RAM is treated as no limit at all.
 */
function containerLimitBytes() {
  /*
   * An explicit override, for a platform that does not expose cgroups to the
   * process and for testing this path on a developer machine, where the
   * detected limit is the whole laptop and the guard would never fire.
   */
  const override = Number(process.env.MEMORY_LIMIT_MB);
  if (Number.isFinite(override) && override > 0) return override * MB;

  const candidates = [
    '/sys/fs/cgroup/memory.max',                    // cgroup v2
    '/sys/fs/cgroup/memory/memory.limit_in_bytes',  // cgroup v1
  ];
  for (const file of candidates) {
    try {
      const raw = fs.readFileSync(file, 'utf8').trim();
      if (raw === 'max') continue;
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0) continue;
      if (value >= os.totalmem()) continue;         // unlimited, reported as a sentinel
      return value;
    } catch { /* not cgroup-managed, or not readable */ }
  }
  const total = os.totalmem();
  return Number.isFinite(total) && total > 0 ? total : null;
}

/*
 * Headroom the refresh worker needs, in MB.
 *
 * The worker is capped at 300MB of old generation (see startRefresh), and a V8
 * heap of that size costs more than that in RSS once its semi-spaces, code and
 * external buffers are counted. 380 is that cap plus a deliberately
 * uncomfortable margin: being wrong in the optimistic direction means the OOM
 * killer, and being wrong in the pessimistic direction means the data is a day
 * older than it could have been.
 */
const REFRESH_HEADROOM_MB = 380;

/*
 * Can a refresh run right now without risking the container?
 *
 * Returns a reason string when it cannot, which is surfaced through /api/meta
 * rather than only logged — an operator looking at a stale snapshot should not
 * have to read container logs to find out why it stopped updating.
 */
function refreshFeasibility(headroomMb = REFRESH_HEADROOM_MB, what = 'a refresh') {
  const limit = containerLimitBytes();
  if (!limit) return { ok: true, limitMb: null, rssMb: null, headroomMb: null, reason: '' };

  const rss = process.memoryUsage().rss;
  const limitMb = Math.round(limit / MB);
  const rssMb = Math.round(rss / MB);
  const freeMb = limitMb - rssMb;
  if (freeMb >= headroomMb) return { ok: true, limitMb, rssMb, headroomMb: freeMb, reason: '' };

  return {
    ok: false,
    limitMb,
    rssMb,
    headroomMb: freeMb,
    reason: `this instance has ${limitMb}MB total and is using ${rssMb}MB; ` +
      `${what} needs about ${headroomMb}MB of headroom and only ${freeMb}MB is free`,
  };
}

module.exports = { containerLimitBytes, refreshFeasibility, REFRESH_HEADROOM_MB };
