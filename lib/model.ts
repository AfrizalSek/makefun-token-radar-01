// Token Radar's model, radar-2: one sealed snapshot in, one ranked board out.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) and every
// other pre-token protocol the snapshot records: the early rows the radar exists to find. A protocol
// is pre-token when its record carries no token (no market cap, no CoinGecko id, no symbol); the
// snapshot's live-token protocols are kept apart as the model's comps and shown with the market's own
// values, never mixed into the ranked board.
//
// Implied value is a comps model, fitted from the snapshot's own live-token protocols:
//
//   multiple   = the kernel-weighted median of ln(market cap / TVL) over the live comps,
//                Gaussian kernel on ln(TVL) distance (bandwidth 1.0), same-category comps
//                weighted 1.0, other categories 0.35; clamped to [0.02, 5.0]
//   spread     = the standard error of that median (1.2533 x sigma / sqrt(n_eff)): the range
//                around a row's implied value is one standard error either way
//   growth     = clamp(change_7d, -60, 120) per cent
//   growthMult = 1 + (growth / 100) x 0.5
//   maturity   = 0.6 + min(age_days, 1095) / 1095 x 0.4   (age_days unknown: 365)
//   implied    = max(1, round(tvl_usd x multiple x growthMult x maturity))
//
// The multiple is what a token would be worth if the protocol's record stayed as it is, priced the
// way the market prices live protocols of the same size and kind. No protocol name is ever
// special-cased: the same function scores every row, and the validation below measures it on the
// live comps it was fitted from, holding each one out in turn.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
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

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them. */
export interface ModelConstants {
  bandwidth: number;
  category_weight: number;
  multiple_min: number;
  multiple_max: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
}

export const MODEL: ModelConstants = {
  bandwidth: 1.0,
  category_weight: 0.35,
  multiple_min: 0.02,
  multiple_max: 5.0,
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** How many nearest comps a row's detail view names. */
export const COMPS_SHOWN = 4;

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One live-token comp, as the kernel sees it. */
export interface Comp {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  logRatio: number;
}

/** A comp as the detail view shows it: the comp, its own multiple, and its kernel weight. */
export interface CompShown {
  slug: string;
  name: string;
  tvl_usd: number;
  mcap_usd: number;
  multiple: number;
  weight: number;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
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
  token_status: 'pre-token';
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  implied_low_usd: number;
  implied_high_usd: number;
  model: {
    multiple: number;
    spread: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with its nearest comps for the detail view. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  watchlist: boolean;
  implied_value_usd: number;
  implied_low_usd: number;
  implied_high_usd: number;
  multiple: number;
  spread: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  comps: CompShown[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** The walk-forward check: the model predicting live protocols it never saw. */
export interface Validation {
  comps: number;
  median_abs_log_error: number;
  median_abs_pct_error: number;
  starter_median_abs_log_error: number;
  starter_median_abs_pct_error: number;
}

/** Everything the dashboard needs: the board, the live set, the validation, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  pre_token_total: number;
  excluded_pre_token: number;
  live_total: number;
  validation: Validation;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Categories that are a wrapped, staked or bridged product of a token that already trades. */
const WRAPPED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** A whole word wrapped, staked or staking anywhere in the name, in any case. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** An exchange's name at the start of the name. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;

/**
 * Whether a protocol is a wrapped, staked or bridged product of a token that already trades: the
 * same rule the snapshot's watchlist uses. Such a protocol is not a launch to find — its token, in
 * effect, already trades — so it is never ranked, even though its record carries no token of its own.
 */
export function isWrappedProduct(p: SnapshotProtocol): boolean {
  return (
    (p.category !== null && WRAPPED_CATEGORIES.has(p.category)) ||
    WRAPPED_WORD.test(p.name) ||
    EXCHANGE_PREFIX.test(p.name)
  );
}

/** Whether a protocol is one the board may rank: pre-token, not a wrapped product, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && !isWrappedProduct(p) && !VERSIONED.test(p.name);
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The live-token comps the kernel prices from: market cap and TVL both positive, no exchange. */
export function liveComps(snapshot: Snapshot): Comp[] {
  return snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.category !== 'CEX')
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd as number,
      logRatio: Math.log((p.mcap_usd as number) / p.tvl_usd),
    }))
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

/** The kernel weight of one comp for a protocol of this TVL and category. */
function kernelWeight(tvl: number, category: string | null, comp: Comp, model: ModelConstants): number {
  const d = Math.log(tvl) - Math.log(comp.tvl_usd);
  const size = Math.exp(-(d * d) / (2 * model.bandwidth * model.bandwidth));
  const same = comp.category !== null && category !== null && comp.category === category;
  return size * (same ? 1 : model.category_weight);
}

/** The weighted median of `values` under `weights`; the plain median when the weights sum to zero. */
function weightedMedian(values: number[], weights: number[]): number {
  const pairs = values.map((v, i) => ({ v, w: weights[i]! })).sort((a, b) => a.v - b.v);
  const total = pairs.reduce((n, p) => n + p.w, 0);
  if (!(total > 0)) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length % 2 === 1 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
  }
  let acc = 0;
  for (const p of pairs) {
    acc += p.w;
    if (acc >= total / 2) return p.v;
  }
  return pairs[pairs.length - 1]!.v;
}

/** The weighted standard deviation of `values` around `centre` under `weights`. */
function weightedStd(values: number[], weights: number[], centre: number): number {
  const total = weights.reduce((n, w) => n + w, 0);
  if (!(total > 0)) return 0;
  const variance = values.reduce((n, v, i) => n + weights[i]! * (v - centre) * (v - centre), 0) / total;
  return Math.sqrt(Math.max(0, variance));
}

/** The fitted multiple for a protocol: the kernel's median log ratio, its standard error, and its nearest comps. */
export function compsMultiple(
  tvl: number,
  category: string | null,
  comps: Comp[],
  model: ModelConstants,
): { multiple: number; logMultiple: number; spread: number; shown: CompShown[] } {
  const weights = comps.map((c) => kernelWeight(tvl, category, c, model));
  const ratios = comps.map((c) => c.logRatio);
  const logMultiple = weightedMedian(ratios, weights);
  // The spread is the standard error of the weighted median (1.2533 x sigma / sqrt(n_eff)), not
  // the comps' own dispersion: it says how precisely the fitted multiple is pinned down, which is
  // what the implied range around a row's point estimate means.
  const sigma = weightedStd(ratios, weights, logMultiple);
  const sumW = weights.reduce((n, w) => n + w, 0);
  const sumW2 = weights.reduce((n, w) => n + w * w, 0);
  const nEff = sumW2 > 0 ? (sumW * sumW) / sumW2 : 0;
  const spread = nEff > 0 ? (1.2533 * sigma) / Math.sqrt(nEff) : sigma;
  const multiple = Math.min(model.multiple_max, Math.max(model.multiple_min, Math.exp(logMultiple)));
  const shown = comps
    .map((c, i) => ({ c, w: weights[i]! }))
    .sort((a, b) => b.w - a.w || (a.c.slug < b.c.slug ? -1 : a.c.slug > b.c.slug ? 1 : 0))
    .slice(0, COMPS_SHOWN)
    .map(({ c, w }) => ({
      slug: c.slug,
      name: c.name,
      tvl_usd: c.tvl_usd,
      mcap_usd: c.mcap_usd,
      multiple: round4(Math.exp(c.logRatio)),
      weight: round4(w),
    }));
  return { multiple, logMultiple, spread, shown };
}

/** The growth and maturity multipliers for a protocol, from its own figures. */
export function factors(protocol: SnapshotProtocol, asOf: string, model: ModelConstants): { growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  return { growthPct, growthMult, maturityMult, age };
}

/** The three multipliers and the implied value one protocol gets under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  comps: Comp[],
  model: ModelConstants,
): { implied: number; low: number; high: number; multiple: number; spread: number; growthPct: number; growthMult: number; maturityMult: number; age: number | null; shown: CompShown[] } {
  const { growthPct, growthMult, maturityMult, age } = factors(protocol, asOf, model);
  const { multiple, spread, shown } = compsMultiple(protocol.tvl_usd, protocol.category, comps, model);
  const base = protocol.tvl_usd * multiple * growthMult * maturityMult;
  const implied = Math.max(1, Math.round(base));
  const low = Math.max(1, Math.round(base * Math.exp(-spread)));
  const high = Math.max(1, Math.round(base * Math.exp(spread)));
  return { implied, low, high, multiple, spread, growthPct, growthMult, maturityMult, age, shown };
}

/**
 * The walk-forward check, leave-one-out over the live comps: each live protocol's market cap is
 * predicted from the other comps only, with the same kernel the board uses — predicted ln(market
 * cap) = ln(TVL) + the kernel's log multiple — and the error is measured against its real market
 * cap. The starter's flat multiple (0.25 x TVL) is scored the same way, on the same held-out
 * protocols, so the two numbers are directly comparable. Growth and maturity are left out of both
 * predictions: they scale every protocol the same way and would only add the held-out week's own
 * market move to the error.
 */
export function validateModel(snapshot: Snapshot, model: ModelConstants = MODEL): Validation {
  const comps = liveComps(snapshot);
  const errors: number[] = [];
  const starterErrors: number[] = [];
  for (const held of comps) {
    const rest = comps.filter((c) => c.slug !== held.slug);
    const { logMultiple } = compsMultiple(held.tvl_usd, held.category, rest, model);
    const actual = Math.log(held.mcap_usd);
    errors.push(Math.abs(Math.log(held.tvl_usd) + logMultiple - actual));
    starterErrors.push(Math.abs(Math.log(held.tvl_usd * 0.25) - actual));
  }
  const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 === 1 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
  };
  const med = median(errors);
  const starterMed = median(starterErrors);
  return {
    comps: comps.length,
    median_abs_log_error: round4(med),
    median_abs_pct_error: round4((Math.exp(med) - 1) * 100),
    starter_median_abs_log_error: round4(starterMed),
    starter_median_abs_pct_error: round4((Math.exp(starterMed) - 1) * 100),
  };
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/**
 * The chain a farm step names. The snapshot's first chain, except a Bitlayer product, whose
 * vaults run on Bitlayer itself: the official YBTC deposit guide (docs.bitlayer.org) takes
 * YBTC.B or Bitlayer native BTC into a Bitlayer vault, and the snapshot lists the YBTC family
 * under Bitcoin and Ethereum only, so the chain is named from the protocol's own docs.
 */
function farmChain(p: SnapshotProtocol): string {
  if (p.name.toLowerCase().includes('bitlayer')) return 'Bitlayer';
  return chainOf(p);
}

/** Approximate gas for one transaction on a chain, in dollars: Ethereum mainnet is dear, Bitcoin middling, the rest cheap. */
function gasFor(chain: string): number {
  if (chain === 'Ethereum') return 8;
  if (chain === 'Bitcoin') return 3;
  return 1;
}

/** The wallet a farm step tells the farmer to set up, in the chain's own terms. */
function walletFor(chain: string): string {
  if (chain === 'Bitcoin') return 'a fresh Bitcoin wallet';
  if (chain === 'Solana') return 'a fresh Solana wallet';
  if (chain === 'Sui') return 'a fresh Sui wallet';
  return `a fresh wallet on ${chain}`;
}

/** Step 1: set up a wallet, in the chain's own terms; a watchlist protocol gets a dedicated wallet. */
function setupText(p: SnapshotProtocol, chain: string, watchlist: boolean): string {
  const wallet = walletFor(chain);
  if (watchlist) return `Set up ${wallet} just for ${p.name} on ${chain} — the watchlist names this protocol — and keep its seed phrase offline.`;
  return `Set up ${wallet} that holds only the funds you plan to farm on ${chain}, and keep its seed phrase offline.`;
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge') || c.includes('cross chain')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('indexes')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  if (c.includes('launchpad')) return `Commit $${capital} of USDC to the ${name} sale on ${chain} and hold the allocation.`;
  if (c.includes('payment')) return `Route $${capital} of payments through ${name} on ${chain} and keep the receipts.`;
  if (c.includes('gaming') || c.includes('social') || c.includes('ai') || c.includes('oracle')) return `Use $${capital} of the ${name} app on ${chain} each week and keep the activity on one wallet.`;
  // BTC-anchored protocols (Anchor BTC, Decentralized BTC) take BTC, not USDC: USDC does not exist
  // natively on Bitcoin. Vishwa bridges BTC to Sui (Fuzzland audit of the Vishwa light client);
  // Bitlayer YBTC takes BTC or YBTC.B into a Bitlayer vault (docs.bitlayer.org); Chain Fusion's
  // ckBTC is minted from native BTC (liquidium.fi docs); SUBFROST wraps BTC into frBTC on Bitcoin
  // itself (docs.subfrost.io). The chain comes from farmChain, which names Bitlayer for Bitlayer.
  if (c.includes('btc')) return `Deposit $${capital} of BTC into ${name} on ${chain} and keep the position open.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** Step 3: a second, different category action each week, distinct from the step-2 action. */
function weeklyActionFor(p: SnapshotProtocol, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Borrow a small amount against the position once a week and repay it, so the wallet shows repeat activity.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('indexes')) return `Read the vault's new allocation note once a week and note any change in strategy.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm') || c.includes('liquidity') || c.includes('farm')) return `Swap a small amount through the pool once a week so the wallet shows repeat activity.`;
  if (c.includes('bridge') || c.includes('cross chain')) return `Bridge a small amount back or to a second chain once a week through the same route.`;
  if (c.includes('staking') || c.includes('restak')) return `Claim or compound the staking reward once a week and keep the receipt token.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options') || c.includes('basis')) return `Close and reopen a small hedge once a week instead of leaving one trade untouched.`;
  if (c.includes('prediction')) return `Settle one market position a week and place a fresh one on ${name}.`;
  if (c.includes('stable')) return `Move a small amount in and out of the stable asset once a week through the same route.`;
  if (c.includes('rwa')) return `Check the yield asset's new accrual once a week and record the balance.`;
  if (c.includes('insurance')) return `Check the cover's terms once a week and note any change in the policy.`;
  if (c.includes('launchpad')) return `Check the sale's next round once a week and note the allocation window.`;
  if (c.includes('payment')) return `Route one small payment through ${name} on ${chain} once a week and keep the receipt.`;
  if (/\b(gaming|social|ai|oracle)\b/.test(c)) return `Use the ${name} app once a week and keep the activity on the same wallet.`;
  if (c.includes('btc')) return `Check the BTC peg and the protocol's backing once a week and record the rate.`;
  return `Repeat the deposit action with a small amount once a week so the wallet shows repeat activity.`;
}

/** Step 4: the hold, with the reason varying by the protocol's age, category, chain and whether the watchlist names it. */
function holdText(p: SnapshotProtocol, age: number | null, hold: number, watchlist: boolean, chain: string): string {
  if (age !== null && age < 180) return `Hold the position for at least ${hold} days — young protocols often snapshot early on ${chain}, so a longer window counts.`;
  if (watchlist) return `Hold the position for at least ${hold} days; the watchlist already tracks this protocol, so the hold is about qualifying.`;
  if (age !== null && age >= 365) return `Hold the position for at least ${hold} days; a mature ${p.category ?? 'protocol'} protocol's snapshots reward a steady position.`;
  return `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`;
}

/** Categories whose apps plausibly run a points, rewards or eligibility program. */
const POINTS_CATEGORIES = ['dex', 'yield', 'lend', 'cdp', 'collateral', 'staking', 'restak', 'perpetual', 'derivative', 'options', 'basis', 'curator', 'allocator', 'indexes', 'prediction', 'farm', 'launchpad', 'governance'];

/** Step 5: rewards, without assuming every protocol runs a points program. */
function rewardsText(p: SnapshotProtocol, chain: string, watchlist: boolean): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('btc')) return `Before you withdraw, check the protocol's official docs for how wrapped BTC is redeemed on ${chain} and whether any rewards program applies.`;
  if (POINTS_CATEGORIES.some((k) => c.includes(k))) {
    if (watchlist) return `Before you withdraw, check the protocol's official app on ${chain} for any points, rewards or eligibility program — the watchlist already tracks this protocol — and follow only the link it publishes.`;
    return `Before you withdraw, check the protocol's official app on ${chain} for any points, rewards or eligibility program and follow only the link it publishes.`;
  }
  return `Before you withdraw, check the protocol's official docs for any eligibility or rewards program; if it has none, record the position on ${chain} and move on.`;
}

/** Step 6: the farm log, with the note varying by the position's size, the protocol's age and the chain. */
function logText(p: SnapshotProtocol, age: number | null, chain: string): string {
  if (p.tvl_usd >= 1_000_000_000) return `Write the wallet, the dates and every transaction on ${chain} in a farm log; a large position is worth a full record before you unwind it.`;
  if (age !== null && age < 180) return `Write the wallet, the dates and every transaction on ${chain} in a farm log and review it weekly while the protocol is young.`;
  if (p.tvl_usd < 100_000_000) return `Write the wallet, the dates and every transaction on ${chain} in a farm log; small positions are easy to forget, so the log is the record.`;
  return `Write the wallet, the dates and every transaction on ${chain} in a farm log so you can repeat the position or unwind it.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. Every step varies
 * with the protocol's own record (category, chains, TVL, age, watchlist), so no two protocols
 * share a plan unless their records agree on every input that shapes it.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, watchlist: boolean): FarmStep[] {
  const chain = farmChain(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasFor(chain);
  return [
    {
      text: setupText(p, chain, watchlist),
      cost: `about $${gas} of gas for the first transaction`,
      time: '5 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital and about $${gas} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: weeklyActionFor(p, chain),
      cost: `about $${gas} of gas a week`,
      time: '10 minutes a week',
    },
    {
      text: holdText(p, age, hold, watchlist, chain),
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: rewardsText(p, chain, watchlist),
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: logText(p, age, chain),
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const comps = liveComps(snapshot);
  const index = bySlug(snapshot.protocols);
  const watchlist = new Set(snapshot.watchlist);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug it names.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other rankable pre-token protocol the snapshot records, not just the
  // biggest by TVL. A board that stops at 200 rows leaves early finds off the board.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, comps, model);
    return { p, v };
  });
  scored.sort((a, b) => b.v.implied - a.v.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    watchlist: watchlist.has(s.p.slug),
    age_days: s.v.age,
    implied_value_usd: s.v.implied,
    implied_low_usd: s.v.low,
    implied_high_usd: s.v.high,
    model: {
      multiple: s.v.multiple,
      spread: s.v.spread,
      growth_pct: s.v.growthPct,
      growth_multiplier: s.v.growthMult,
      maturity_multiplier: s.v.maturityMult,
      age_days: s.v.age,
    },
    farm_steps: farmSteps(s.p, s.v.age, watchlist.has(s.p.slug)).map(stepText),
  }));
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, with its nearest comps for the detail view. */
export function radarRow(row: BoardRow, comps: Comp[], model: ModelConstants = MODEL): RadarRow {
  const { shown } = compsMultiple(row.tvl_usd, row.category, comps, model);
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    watchlist: row.watchlist,
    implied_value_usd: row.implied_value_usd,
    implied_low_usd: row.implied_low_usd,
    implied_high_usd: row.implied_high_usd,
    multiple: row.model.multiple,
    spread: row.model.spread,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    comps: shown,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const comps = liveComps(snapshot);
  const early = board.filter((r) => !r.watchlist).length;
  const preTokenTotal = snapshot.protocols.filter(isPreToken).length;
  const excludedPreToken = preTokenTotal - board.length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    pre_token_total: preTokenTotal,
    excluded_pre_token: excludedPreToken,
    live_total: comps.length,
    validation: validateModel(snapshot, model),
    rows: board.map((r) => radarRow(r, comps, model)),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
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
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
