# Bushi Collection — Auction Site (Phase 2)

CN Nouns–inspired UI for **Bushi Collection** English auctions on Base.

## Sepolia addresses

| Contract | Address |
|----------|---------|
| Collection | `0x4BE9e05b953849f13C0e27A257A8D89b4D221318` |
| Auction | `0xCbf8d57F2fc99566b859a2243045E70092054e17` |

## Dev

```bash
cd bushi-collection-site
npm install
npm run dev
```

Optional Alchemy RPC:

```bash
echo 'VITE_RPC_URL=https://base-sepolia.g.alchemy.com/v2/YOUR_KEY' > .env
```

## Build (GitHub Pages / static)

```bash
npm run build
# output: dist/  (base: ./  → works on project pages)
```

### Publish to GitHub Pages

1. Create empty GitHub repo (e.g. `bushi-collection-site`)
2. Local:

```bash
cd /Users/gpro/bushi-collection-site
git init
git add .
git commit -m "Phase 2: Bushi Collection auction site (Sepolia)"
git branch -M main
git remote add origin git@github.com:YOUR_ORG/bushi-collection-site.git
git push -u origin main
```

3. Repo → **Settings → Pages → Source: GitHub Actions**
4. Optional: **Settings → Secrets → Actions** → `VITE_RPC_URL` (Alchemy Base Sepolia)
5. Workflow **Deploy GitHub Pages** runs on push to `main`
6. URL: `https://YOUR_ORG.github.io/bushi-collection-site/`

If the site is under a **project** path and assets 404, set in `vite.config.ts`:

```ts
base: process.env.GITHUB_REPOSITORY
  ? `/${process.env.GITHUB_REPOSITORY.split("/")[1]}/`
  : "./",
```

Current default `base: "./"` is relative and usually works for project Pages.

## Features

- Big art panel + bid / countdown (JP)
- Injected wallet (MetaMask etc.) · Base Sepolia
- `bid` · `settle` · `withdraw` (pull refunds)
- **Admin panel** (owner only): `createAuction`
- Polls `auctionState` every 8s
- Metadata: `ar://` / `ipfs://` → HTTP; tries JSON `image`

## Backlog (UI)

- [x] Show metadata **name / description / attributes** (OpenSea-style, compact)
- [ ] Further UX polish (history strip, JP/EN toggle, etc.)

## Owner

- **Admin panel** (connected auction **owner** only): create next lot  
- `setDefaultArtist` / pause still via cast if needed  
