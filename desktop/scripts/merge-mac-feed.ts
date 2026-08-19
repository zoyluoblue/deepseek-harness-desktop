/**
 * Merge the per-arch macOS update feeds from the two native macOS build legs
 * into the single latest-mac.yml electron-updater reads.
 *
 * electron-builder writes one feed per invocation and macOS has no arch-suffixed
 * feed name (only Linux gets one), so both legs publish competing copies of the
 * same release asset and the last upload wins. A single-arch feed is worse than
 * a missing one: electron-updater's MacUpdater selects a file by testing its URL
 * for the literal substring `arm64`, and when the feed holds no arm64 entry it
 * serves the Intel build to Apple Silicon users rather than reporting an error.
 *
 * Usage: tsx merge-mac-feed.ts <output> <feed...>
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dump, load } from 'js-yaml'

/** One artifact in an electron-updater feed. */
interface FeedFile {
  url: string
  sha512: string
  size: number
}

/** The `latest-mac.yml` document electron-builder emits. */
interface Feed {
  version: string
  files: FeedFile[]
  path: string
  sha512: string
  releaseDate: string
}

const [output, ...inputs] = process.argv.slice(2)
if (output === undefined || inputs.length === 0) {
  throw new Error('merge-mac-feed: usage: merge-mac-feed.ts <output> <feed...>')
}

const feeds: Feed[] = []
for (const input of inputs) {
  feeds.push(load(await readFile(input, 'utf8')) as Feed)
}

const versions = new Set(feeds.map(feed => feed.version))
if (versions.size !== 1) {
  throw new Error(`merge-mac-feed: feeds disagree on version: ${[...versions].sort().join(', ')}`)
}

const byUrl = new Map<string, FeedFile>()
for (const feed of feeds) {
  for (const file of feed.files) byUrl.set(file.url, file)
}
// electron-builder orders a single invocation's files by ascending Arch enum
// (x64 before arm64); reproduce that so the legacy top-level fields, which
// electron-updater 1.x reads instead of `files`, name the same artifact they
// would in a single-arch build.
const files = [...byUrl.values()].sort((left, right) =>
  Number(left.url.includes('arm64')) - Number(right.url.includes('arm64')))

const [primary] = files
if (primary === undefined) throw new Error('merge-mac-feed: no files across the given feeds')

const merged: Feed = {
  version: feeds[0]!.version,
  files,
  path: primary.url,
  sha512: primary.sha512,
  releaseDate: feeds.map(feed => feed.releaseDate).sort().at(-1)!,
}

await writeFile(output, dump(merged, { lineWidth: -1 }))
console.log(`merge-mac-feed: wrote ${output} with ${String(files.length)} files: ${files.map(file => file.url).join(', ')}`)
