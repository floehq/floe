# Floe CLI

`@floehq/cli` is the official command-line interface for the Floe API.

## Install

```bash
npm install -g @floehq/cli
```

Or run without a global install:

```bash
npx @floehq/cli --help
```

## Commands

```bash
floe upload ./video.mp4
floe upload status <uploadId>
floe upload cancel <uploadId>
floe upload complete <uploadId>
floe upload wait <uploadId>
floe file metadata <fileId>
floe file manifest <fileId>
floe file stream-url <fileId>
floe ops health
floe config show
```

Shortcuts are also supported for the most common lookups:

```bash
floe status <uploadId>
floe cancel <uploadId>
floe metadata <fileId>
floe manifest <fileId>
floe stream-url <fileId>
```
