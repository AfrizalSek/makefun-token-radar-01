// Token Radar, model radar-3 — written fresh in the rebuild session.
//
// What it does, in one paragraph: it reads the sealed DefiLlama snapshot,
// keeps the 119 live-token protocols (token trades, market cap above zero,
// TVL above zero, not an exchange) as the comparison set, and prices every
// rankable pre-token protocol from them with a kernel-weighted median of
// log(market cap / TVL). The board is every rankable pre-token protocol the
// snapshot records — the 40 watchlist names plus every other one that passes
// the watchlist's own rule (not an exchange, not a wrapped / staked /
// bridged product, not a versioned pool). No protocol name is special-cased
// anywhere in the scoring: the same function scores every row, and the
// constants below are the only numbers the model adds to the snapshot.
//
// The two things the first build got wrong are fixed here by construction:
// the leave-one-out check is run twice — once for the multiple alone and
// once for the full board formula (clamp, growth and maturity included), so
// the dashboard never presents a partial check as the whole model's
// accuracy; and the farm plans never tell a reader to move USDC on Bitcoin.

export interface Proto {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snap {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Proto[];
  watchlist: string[];
}

/** Every number the model adds to the snapshot, stated in one place. */
export const TUNING = {
  bandwidth: 1.0, // Gaussian kernel width on ln(TVL) distance
  sameCategory: 1.0, // weight of a comp in the protocol's own category
  otherCategory: 0.35, // weight of a comp in any other category
  multipleLow: 0.02, // clamp on the fitted multiple
  multipleHigh: 5.0,
  growthWeight: 0.5, // how much of the 7-day TVL change feeds the price
  growthLow: -60, // clamp on the 7-day change, in per cent
  growthHigh: 120,
  maturityFloor: 0.6, // youngest protocols still keep 60% of the multiple
  maturitySpan: 0.4, // up to +40% for three years without a token
  maturityDays: 1095, // three years, in days
  unknownAgeDays: 365, // a protocol with no listing date counts as one year old
} as const;

export const MODEL_VERSION = 'radar-3';
export const LIVE_SHOWN = 24;

/** Categories the watchlist rule treats as a wrapped / staked / bridged product. */
const WRAPPED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

const VERSION_TAIL = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\bwrapped\b|\bstaked\b|\bstaking\b/i;

export class SnapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapError';
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Days from `listedAt` to the snapshot date; null when the date is missing. */
export function daysOld(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** True when the snapshot records no token at all for this protocol. */
export function hasNoToken(p: Proto): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * True when the protocol may be ranked: it records no token, and it is not
 * an exchange, a wrapped / staked / bridged product, or a versioned pool.
 * This is the watchlist's own rule, applied to the whole snapshot — which is
 * why the board it produces holds exactly the watchlist plus the early
 * protocols the radar exists to find.
 */
export function rankable(p: Proto): boolean {
  if (!hasNoToken(p)) return false;
  if (p.category !== null && WRAPPED_CATEGORIES.has(p.category)) return false;
  if (VERSION_TAIL.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  return true;
}

/** The comparison set: live tokens with a market cap and TVL, no exchanges. */
export function compSet(snap: Snap): Proto[] {
  return snap.protocols
    .filter((p) => !hasNoToken(p) && (p.mcap_usd ?? 0) > 0 && p.tvl_usd > 0 && p.category !== 'CEX')
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

interface WeightedLog {
  logRatio: number;
  weight: number;
}

/** Kernel weights of every comp against a query TVL and category. */
function kernelRows(query: Proto, comps: Proto[]): WeightedLog[] {
  const q = Math.log(query.tvl_usd);
  return comps.map((c) => {
    const d = q - Math.log(c.tvl_usd);
    const near = Math.exp(-(d * d) / (2 * TUNING.bandwidth * TUNING.bandwidth));
    const same = c.category !== null && c.category === query.category;
    return {
      logRatio: Math.log((c.mcap_usd as number) / c.tvl_usd),
      weight: near * (same ? TUNING.sameCategory : TUNING.otherCategory),
    };
  });
}

/** The weighted median of the log ratios: the fitted log-multiple. */
export function kernelLogMultiple(query: Proto, comps: Proto[]): number {
  const rows = kernelRows(query, comps).sort((a, b) => a.logRatio - b.logRatio);
  const total = rows.reduce((s, r) => s + r.weight, 0);
  let acc = 0;
  for (const r of rows) {
    acc += r.weight;
    if (acc >= total / 2) return r.logRatio;
  }
  return rows.length > 0 ? rows[rows.length - 1]!.logRatio : Math.log(0.25);
}

/** Effective sample size of a weighted set, for the spread below. */
function effN(rows: WeightedLog[]): number {
  const s1 = rows.reduce((s, r) => s + r.weight, 0);
  const s2 = rows.reduce((s, r) => s + r.weight * r.weight, 0);
  return s2 > 0 ? (s1 * s1) / s2 : 0;
}

/**
 * The spread of the fitted multiple: 1.2533 x the weighted standard
 * deviation of the log ratios, divided by the square root of the effective
 * sample size. The 1.2533 is the median's asymptotic factor (sqrt(pi/2)).
 */
export function kernelSpread(query: Proto, comps: Proto[], logMultiple: number): number {
  const rows = kernelRows(query, comps);
  const n = effN(rows);
  if (n <= 0) return 2.26;
  const mean = rows.reduce((s, r) => s + r.weight * r.logRatio, 0) / rows.reduce((s, r) => s + r.weight, 0);
  const variance =
    rows.reduce((s, r) => s + r.weight * (r.logRatio - mean) * (r.logRatio - mean), 0) /
    rows.reduce((s, r) => s + r.weight, 0);
  return (1.2533 * Math.sqrt(variance)) / Math.sqrt(n);
}

export interface Scored {
  implied: number;
  low: number;
  high: number;
  multiple: number;
  logMultiple: number;
  spread: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  age: number | null;
  compsUsed: number;
  nearest: { slug: string; name: string; multiple: number }[];
}

/** Growth and maturity multipliers for one protocol, from its own record. */
export function growthAndMaturity(
  p: Proto,
  asOf: string,
): { growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = daysOld(asOf, p.listed_at);
  const raw = finiteOr(p.change_7d, 0);
  const growthPct = Math.min(TUNING.growthHigh, Math.max(TUNING.growthLow, raw));
  const growthMult = 1 + (growthPct / 100) * TUNING.growthWeight;
  const ageForModel = age ?? TUNING.unknownAgeDays;
  const capped = Math.min(Math.max(ageForModel, 0), TUNING.maturityDays);
  const maturityMult = TUNING.maturityFloor + (capped / TUNING.maturityDays) * TUNING.maturitySpan;
  return { growthPct, growthMult, maturityMult, age };
}

/** The full board formula for one protocol, fitted from `comps`. */
export function scoreOne(p: Proto, asOf: string, comps: Proto[]): Scored {
  const logMultiple = kernelLogMultiple(p, comps);
  const multiple = Math.min(TUNING.multipleHigh, Math.max(TUNING.multipleLow, Math.exp(logMultiple)));
  const spread = kernelSpread(p, comps, logMultiple);
  const { growthPct, growthMult, maturityMult, age } = growthAndMaturity(p, asOf);
  const base = p.tvl_usd * multiple * growthMult * maturityMult;
  const implied = Math.max(1, Math.round(base));
  const low = Math.max(1, Math.round(base * Math.exp(-spread)));
  const high = Math.max(1, Math.round(base * Math.exp(spread)));
  const nearest = comps
    .map((c) => ({
      slug: c.slug,
      name: c.name,
      multiple: (c.mcap_usd as number) / c.tvl_usd,
      dist: Math.abs(Math.log(p.tvl_usd) - Math.log(c.tvl_usd)),
    }))
    .sort((a, b) => a.dist - b.dist || (a.slug < b.slug ? -1 : 1))
    .slice(0, 3)
    .map((c) => ({ slug: c.slug, name: c.name, multiple: round4(c.multiple) }));
  return {
    implied,
    low,
    high,
    multiple: round4(multiple),
    logMultiple: round4(logMultiple),
    spread: round4(spread),
    growthPct,
    growthMult: round4(growthMult),
    maturityMult: round4(maturityMult),
    age,
    compsUsed: comps.length,
    nearest,
  };
}

export interface Validation {
  comps: number;
  /** Leave-one-out on the multiple alone (no clamp, no growth, no maturity). */
  multipleOnly: { medianAbsLogError: number; medianAbsPctError: number; baselineMedianAbsLogError: number; baselineMedianAbsPctError: number; wins: number };
  /** Leave-one-out on the full board formula, clamp and all. */
  fullFormula: { medianAbsLogError: number; medianAbsPctError: number; baselineMedianAbsLogError: number; baselineMedianAbsPctError: number; wins: number };
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function pctFromLog(logErr: number): number {
  return (Math.exp(logErr) - 1) * 100;
}

/**
 * Leave-one-out validation over the comparison set, run two ways. In both,
 * the held-out protocol never enters its own comparison set and its market
 * cap is never an input — only its TVL and category locate the kernel. The
 * baseline in both is the flat 0.25x multiple the starter shipped with.
 * The dashboard shows both numbers and says which one matches the board.
 */
export function validateModel(snap: Snap, comps: Proto[]): Validation {
  const multiErr: number[] = [];
  const multiBase: number[] = [];
  const fullErr: number[] = [];
  const fullBase: number[] = [];
  let multiWins = 0;
  let fullWins = 0;
  for (const held of comps) {
    const rest = comps.filter((c) => c.slug !== held.slug);
    const logMult = kernelLogMultiple(held, rest);
    const actual = Math.log((held.mcap_usd as number) / held.tvl_usd);
    const eMulti = Math.abs(logMult - actual);
    const eMultiBase = Math.abs(Math.log(0.25) - actual);
    multiErr.push(eMulti);
    multiBase.push(eMultiBase);
    if (eMulti < eMultiBase) multiWins++;
    // Full formula: clamp the multiple, then apply this protocol's own
    // growth and maturity — exactly what the board does for a ranked row.
    const multiple = Math.min(TUNING.multipleHigh, Math.max(TUNING.multipleLow, Math.exp(logMult)));
    const { growthMult, maturityMult } = growthAndMaturity(held, snap.as_of);
    const predicted = held.tvl_usd * multiple * growthMult * maturityMult;
    const eFull = Math.abs(Math.log(predicted / (held.mcap_usd as number)));
    const basePredicted = held.tvl_usd * 0.25 * growthMult * maturityMult;
    const eFullBase = Math.abs(Math.log(basePredicted / (held.mcap_usd as number)));
    fullErr.push(eFull);
    fullBase.push(eFullBase);
    if (eFull < eFullBase) fullWins++;
  }
  const mMulti = medianOf(multiErr);
  const mMultiBase = medianOf(multiBase);
  const mFull = medianOf(fullErr);
  const mFullBase = medianOf(fullBase);
  return {
    comps: comps.length,
    multipleOnly: {
      medianAbsLogError: round4(mMulti),
      medianAbsPctError: round4(pctFromLog(mMulti)),
      baselineMedianAbsLogError: round4(mMultiBase),
      baselineMedianAbsPctError: round4(pctFromLog(mMultiBase)),
      wins: multiWins,
    },
    fullFormula: {
      medianAbsLogError: round4(mFull),
      medianAbsPctError: round4(pctFromLog(mFull)),
      baselineMedianAbsLogError: round4(mFullBase),
      baselineMedianAbsPctError: round4(pctFromLog(mFullBase)),
      wins: fullWins,
    },
  };
}

// ---------------------------------------------------------------- farm plans

/** Gas for one ordinary transaction on a chain family, in whole dollars. */
function gasFor(chain: string): number {
  if (chain === 'Ethereum') return 8;
  if (chain === 'Bitcoin') return 3;
  if (chain === 'Solana') return 1;
  if (chain === 'Tron') return 2;
  return 4;
}

function capitalFor(p: Proto): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

function holdFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

function firstChain(p: Proto): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

function isBtcFamily(p: Proto): boolean {
  return (p.category ?? '').toLowerCase().includes('btc');
}

/**
 * The deposit asset and chain for the plan's main action. Anything whose
 * deposit chain is Bitcoin takes BTC — never USDC on Bitcoin, which does
 * not exist as a native asset there. That covers the Bitcoin-anchored
 * protocols (their category names BTC) and also the two that only happen
 * to list Bitcoin first: Lightning Network (its network moves BTC) and
 * BIMA CDP (a Bitcoin-backed stablecoin protocol, so the collateral is
 * BTC). Bitlayer's own product runs on Bitlayer, per its own docs.
 * Everything else deposits USDC on the protocol's first listed chain.
 */
function depositAsset(p: Proto): { asset: string; chain: string } {
  if (p.slug.startsWith('bitlayer') || p.name.toLowerCase().includes('bitlayer')) {
    return { asset: 'BTC', chain: 'Bitlayer' };
  }
  const chain = firstChain(p);
  if (chain === 'Bitcoin' || isBtcFamily(p)) {
    return { asset: 'BTC', chain };
  }
  return { asset: 'USDC', chain };
}

/** The main farming action for one protocol, from its category and record. */
function mainAction(p: Proto, capital: number, asset: string, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('curator') || c.includes('allocator') || c.includes('indexes') || c.includes('index'))
    return `Deposit $${capital} of ${asset} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral'))
    return `Supply $${capital} of ${asset} to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm') || c.includes('liquidity manager'))
    return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge'))
    return `Bridge $${capital} of ${asset} to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak'))
    return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative'))
    return `Deposit $${capital} of ${asset} as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction'))
    return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('stable'))
    return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa'))
    return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance'))
    return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  if (c.includes('payment'))
    return `Route $${capital} of ${asset} through ${name} on ${chain} and keep the receipt.`;
  return `Deposit $${capital} of ${asset} into ${name} on ${chain} and keep the position open.`;
}

/** A second, different qualifying action for the same protocol. */
function secondAction(p: Proto): string {
  const c = (p.category ?? '').toLowerCase();
  if (isBtcFamily(p)) return 'move a second, smaller BTC deposit through the same vault and check the peg holds';
  if (c.includes('curator') || c.includes('allocator') || c.includes('indexes') || c.includes('index'))
    return 'review the vault allocation and rebalance into a second vault';
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral'))
    return 'borrow a small amount against the position, then repay it';
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm') || c.includes('liquidity manager'))
    return 'swap a small amount in the same pool and add the proceeds back';
  if (c.includes('bridge')) return 'bridge a second, smaller amount back and check the receipt';
  if (c.includes('staking') || c.includes('restak')) return 'top up the stake once and check the receipt updates';
  if (c.includes('perpetual') || c.includes('derivative')) return 'close the hedge and open a fresh one at a smaller size';
  if (c.includes('prediction')) return 'settle the first position before placing a second one';
  if (c.includes('stable')) return 'redeem a small part of the stable position and re-mint it';
  if (c.includes('rwa')) return 'check the yield asset accrues and record the new balance';
  if (c.includes('insurance')) return 'read the cover terms again and note the expiry date';
  if (c.includes('gaming') || c.includes('social') || c.includes('ai ') || c.includes('oracle'))
    return 'use the app once more and record what changed since the first visit';
  return 'repeat the deposit with a smaller amount and record both transactions';
}

/** The setup step, varied by chain family and by watchlist membership. */
function setupStep(p: Proto, onWatchlist: boolean): string {
  const chain = firstChain(p);
  const tail = onWatchlist
    ? ' This protocol is on the snapshot watchlist, so keep the wallet separate from your main funds.'
    : ' Keep this wallet separate from your main funds.';
  if (chain === 'Bitcoin')
    return `Use a fresh Bitcoin-capable wallet that holds only the funds you plan to farm, and keep its seed phrase offline.${tail}`;
  if (chain === 'Solana')
    return `Use a fresh Solana wallet that holds only the funds you plan to farm, and keep its seed phrase offline.${tail}`;
  return `Use a fresh wallet on ${chain} that holds only the funds you plan to farm, and keep its seed phrase offline.${tail}`;
}

/** The points step: hedged — it never assumes a points program exists. */
function pointsStep(p: Proto): string {
  const chain = firstChain(p);
  if (isBtcFamily(p))
    return `Check ${p.name}'s official app or docs on ${chain} for any points, rewards, or qualification program and whether this activity counts; follow only a link the protocol itself publishes.`;
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('curator') || c.includes('allocator'))
    return `Check ${p.name}'s official vault page on ${chain} for any points, rewards, or qualification program and whether vault shares count; follow only a link the protocol itself publishes.`;
  return `Check ${p.name}'s official app or docs for any points, rewards, or qualification program and whether this activity counts; follow only a link the protocol itself publishes.`;
}

function holdStep(p: Proto, age: number | null, hold: number, onWatchlist: boolean): string {
  const chain = firstChain(p);
  const ageNote =
    age !== null && age < 180
      ? ' A younger protocol changes fast, so check the position weekly while it runs.'
      : age !== null && age >= 1095
        ? ' The protocol has run for years, so the check is the position itself, not the calendar.'
        : ' Check the position weekly while it runs.';
  const chainNote =
    chain === 'Bitcoin'
      ? ' Bitcoin fees move with the mempool, so check the fee before each weekly action.'
      : chain === 'Solana'
        ? ' Solana fees stay near a cent, so the weekly action costs almost nothing.'
        : chain === 'Ethereum'
          ? ' Ethereum gas moves with the network, so pick a quiet hour for the weekly action.'
          : ` On ${chain}, check the fee before each weekly action.`;
  const watch = onWatchlist ? ' Watchlist protocols are the radar\'s core, so keep the log complete.' : '';
  return `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.${ageNote}${chainNote}${watch}`;
}

function logStep(p: Proto, capital: number, age: number | null, onWatchlist: boolean): string {
  const notes: string[] = [];
  if (p.tvl_usd >= 1_000_000_000) notes.push(`with the $${capital} position marked as a large-protocol position`);
  else if (p.tvl_usd >= 100_000_000) notes.push('with the position size noted beside the entry');
  if (onWatchlist) notes.push('marked as a watchlist position');
  if (age !== null && age < 180) notes.push('with the weekly checks noted while the protocol is young');
  else if (age !== null && age >= 1095) notes.push("with the protocol's long history noted");
  else if (age === null) notes.push('with the listing date marked as unknown');
  const chain = firstChain(p);
  if (chain === 'Bitcoin') notes.push('keeping the Bitcoin transaction ids beside the wallet address');
  else if (chain === 'Solana') notes.push('keeping the Solana transaction signatures beside the wallet address');
  else if (chain === 'Ethereum') notes.push('keeping the Ethereum transaction hashes beside the wallet address');
  const tail = notes.length > 0 ? `, ${notes.join(', ')},` : '';
  return `Write the wallet, the dates and every transaction in a farm log${tail} so you can repeat the position or unwind it.`;
}

function asStep(text: string, cost: string, time: string): string {
  let s = `${text} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time,
 * derived only from the protocol's own record (category, chains, TVL, age,
 * watchlist membership). It promises no airdrop, reward, or profit — it
 * only says what to do, what it costs, and how long it takes.
 */
export function farmPlan(p: Proto, age: number | null, onWatchlist: boolean): string[] {
  const capital = capitalFor(p);
  const hold = holdFor(age);
  const { asset, chain } = depositAsset(p);
  const gas = gasFor(chain);
  const weekly = chain === 'Solana' ? 1 : chain === 'Ethereum' ? 8 : gas;
  return [
    asStep(setupStep(p, onWatchlist), `under $${gas} of gas for the first transaction`, '5 minutes'),
    asStep(mainAction(p, capital, asset, chain), `$${capital} of capital and about $${gas} of gas`, '15 minutes to set up'),
    asStep(
      `Once a week, ${secondAction(p)}.`,
      `about $${weekly} of gas a week`,
      '10 minutes a week',
    ),
    asStep(holdStep(p, age, hold, onWatchlist), `the $${capital} stays in the position`, `${hold} days`),
    asStep(pointsStep(p), 'no fee to check, and never pay to take part', '10 minutes'),
    asStep(logStep(p, capital, age, onWatchlist), 'nothing but the log', '5 minutes'),
  ];
}

// ---------------------------------------------------------------- board

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  token_status: 'pre-token';
  implied_value_usd: number;
  implied_low_usd: number;
  implied_high_usd: number;
  multiple: number;
  spread: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  watchlist: boolean;
  nearest_comps: { slug: string; name: string; multiple: number }[];
  farm_steps: string[];
}

export interface LiveLite {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
}

export interface CompLite {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
}

export interface RadarPayload {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  tuning: typeof TUNING;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  pre_token_total: number;
  excluded_pre_token: number;
  live_total: number;
  live_shown: number;
  validation: Validation;
  rows: BoardRow[];
  live: LiveLite[];
  comps: CompLite[];
}

export interface BuiltRadar {
  board: BoardRow[];
  payload: RadarPayload;
}

/** The whole board: every rankable pre-token protocol, scored and ranked. */
export function buildRadar(snap: Snap): BuiltRadar {
  const comps = compSet(snap);
  const validation = validateModel(snap, comps);
  const watch = new Set(snap.watchlist);
  const candidates = snap.protocols.filter(rankable);
  const scored = candidates.map((p) => ({ p, s: scoreOne(p, snap.as_of, comps) }));
  scored.sort((a, b) => b.s.implied - a.s.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const board: BoardRow[] = scored.map((entry, i) => ({
    rank: i + 1,
    slug: entry.p.slug,
    name: entry.p.name,
    category: entry.p.category,
    chains: entry.p.chains,
    tvl_usd: entry.p.tvl_usd,
    change_7d: entry.p.change_7d,
    listed_at: entry.p.listed_at,
    age_days: entry.s.age,
    token_status: 'pre-token',
    implied_value_usd: entry.s.implied,
    implied_low_usd: entry.s.low,
    implied_high_usd: entry.s.high,
    multiple: entry.s.multiple,
    spread: entry.s.spread,
    growth_multiplier: entry.s.growthMult,
    maturity_multiplier: entry.s.maturityMult,
    watchlist: watch.has(entry.p.slug),
    nearest_comps: entry.s.nearest,
    farm_steps: farmPlan(entry.p, entry.s.age, watch.has(entry.p.slug)),
  }));
  const live: LiveLite[] = [...comps]
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_SHOWN)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd as number,
      change_7d: p.change_7d,
    }));
  const preTotal = snap.protocols.filter(hasNoToken).length;
  const payload: RadarPayload = {
    as_of: snap.as_of,
    source: snap.source,
    floor_usd: snap.floor_usd,
    model_version: MODEL_VERSION,
    tuning: TUNING,
    watchlist_size: snap.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !r.watchlist).length,
    pre_token_total: preTotal,
    excluded_pre_token: preTotal - board.length,
    live_total: comps.length,
    live_shown: live.length,
    validation,
    rows: board,
    live,
    comps: comps.map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd as number,
    })),
  };
  return { board, payload };
}

/** The snapshot out of a file's text, refused unless it is the shape scored. */
export function parseSnap(text: string): Snap {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0)
    throw new SnapError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string'))
    throw new SnapError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null when it is clean. */
export function boardProblem(board: BoardRow[], snap: Snap): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snap.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++)
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd)
    return `all ${board.length} rows share the same implied value`;
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** The dashboard's dataset as one script: no fetch, no network. */
export function dataScript(payload: RadarPayload): string {
  return `window.RADAR=${JSON.stringify(payload)};\n`;
}
