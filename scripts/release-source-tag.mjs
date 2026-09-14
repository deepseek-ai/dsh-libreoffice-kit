/** Require the internal release tag to identify the qualified source commit. */
import { assert } from './verify-artifacts.mjs';

/**
 * Verify a lightweight or annotated source tag without creating or moving it.
 * @param repository - Internal repository hosting both source and binaries.
 * @param tag - Engine release tag.
 * @param source - Qualified source repository and commit.
 * @param run - GitHub CLI runner.
 */
export function verifyReleaseSourceTag(repository, tag, source, run) {
  assert(source.repository === repository, 'Release source and destination repositories differ');
  const read = path => {
    const result = run(['api', `repos/${repository}/${path}`], true);
    assert(result.status === 0, `Read source tag failed: ${result.stderr ?? 'GitHub CLI error'}`);
    return JSON.parse(result.stdout).object;
  };
  let object = read(`git/ref/tags/${tag}`);
  if (object.type === 'tag') object = read(`git/tags/${object.sha}`);
  assert(object.type === 'commit' && object.sha === source.commit, 'Source tag differs from the verified engine commit');
}
