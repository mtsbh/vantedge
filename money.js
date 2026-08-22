// Shared money math + formatting for Vantedge.
//
// Loaded three ways so every surface counts and prints P/L identically:
//   * content script, listed before overlay.js in the manifest
//   * service worker, via importScripts from background.js
//   * popup, via a <script> tag ahead of popup.js
//
// The one rule worth remembering: profit on a bet is stake × (multiplier − 1),
// never payout − stake. See betProfit() for why.
(function (root) {
    'use strict';

    // Display precision per currency: fiat + stablecoins to cents, crypto to the
    // precision the casinos themselves show. Unknown tickers fall back on
    // magnitude (see curDecimals).
    const CURRENCY_DECIMALS = {
        usd: 2, usdt: 2, usdc: 2, dai: 2, busd: 2, tusd: 2, eur: 2, gbp: 2,
        cad: 2, aud: 2, brl: 2, mxn: 2, ars: 2, pen: 2, inr: 2, try: 2,
        jpy: 0, clp: 0, doge: 2, trx: 2, xrp: 4, sol: 4, ada: 4, matic: 4,
        bnb: 6, eth: 6, ltc: 6, bch: 6, btc: 8
    };
    const CURRENCY_SYMBOLS = {
        usd: '$', usdt: '$', usdc: '$', dai: '$', busd: '$', tusd: '$',
        eur: '€', gbp: '£', jpy: '¥', brl: 'R$', cad: 'C$', aud: 'A$'
    };

    function curKey(cur) { return String(cur || 'usd').toLowerCase(); }

    // Decimals to render `cur` with. `mag` (the largest value in play) only
    // matters for tickers that aren't in the table.
    function curDecimals(cur, mag = 0) {
        const d = CURRENCY_DECIMALS[curKey(cur)];
        if (d != null) return d;
        return Math.abs(mag) >= 1 ? 2 : 8;
    }

    // Half a display step: anything smaller rounds to zero, so it counts as
    // neither a win nor a loss when colouring a number.
    function curEpsilon(cur, mag = 0) {
        return Math.pow(10, -curDecimals(cur, mag)) / 2;
    }

    // "+$4.00", "-0.000012 BTC", or "+$1.2k" when compact and large. Crypto
    // keeps its trailing zeros trimmed so 0.00001200 reads as 0.000012.
    function fmtMoney(v, cur = 'usd', { signed = true, compact = false } = {}) {
        const c = curKey(cur);
        const val = Number(v) || 0;
        const sym = CURRENCY_SYMBOLS[c];
        const neg = val < 0;
        const abs = Math.abs(val);
        let n;
        if (compact && abs >= 10000) {
            const units = [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']];
            const [div, suf] = units.find(([d]) => abs >= d);
            n = (abs / div).toFixed(abs / div >= 100 ? 0 : 1).replace(/\.0$/, '') + suf;
        } else {
            n = abs.toFixed(curDecimals(c, abs));
            if (n.indexOf('.') !== -1 && curDecimals(c, abs) > 2) {
                n = n.replace(/0+$/, '').replace(/\.$/, ''); // trim crypto zeros
            }
            const parts = n.split('.');
            parts[0] = Number(parts[0]).toLocaleString('en-US');
            n = parts.join('.');
        }
        const body = sym ? `${sym}${n}` : `${n} ${c.toUpperCase()}`;
        return (neg ? '-' : (signed && val > 0 ? '+' : '')) + body;
    }

    // Amount actually staked, or 0 for free / $0 play.
    function betStake(bet) {
        const amt = Number(bet?.amount ?? bet?.betAmount) || 0;
        return amt > 0 ? amt : 0;
    }

    // Profit on one settled bet: stake × (multiplier − 1). A $2 loss is −$2, a
    // $2 bet paying 3x is +$4.
    //
    // NOT payout − stake: the sites disagree about `payout`. Some record the
    // gross return, others only the profit (injected.js maps one site's
    // `response.profit` straight into it), so subtracting the stake is wrong on
    // half of them. Amount and multiplier mean the same thing everywhere we
    // capture from.
    function betProfit(bet) {
        const stake = betStake(bet);
        if (!stake) return 0; // free play stakes nothing and wins nothing
        const mult = Number(bet?.payoutMultiplier ?? bet?.multiplier) || 0;
        return stake * (mult - 1);
    }

    // Roll a bet list up into P/L, keeping currencies apart — we never invent an
    // exchange rate. The currency with the most paid bets is the headline; the
    // rest come back in `others` so callers can show them alongside.
    //
    // Returns { pl, wagered, cur, bets, roi, others, paid }, where `paid` counts
    // real-money bets across every currency and `bets` only the headline's.
    function summarize(bets) {
        const list = Array.isArray(bets) ? bets : [];
        const by = Object.create(null);
        let paid = 0;
        for (let i = 0; i < list.length; i++) {
            const b = list[i];
            const stake = betStake(b);
            if (!stake) continue; // free/$0 bets excluded
            const cur = curKey(b?.currency);
            const e = by[cur] || (by[cur] = { cur, pl: 0, wagered: 0, bets: 0 });
            e.pl += betProfit(b);
            e.wagered += stake;
            e.bets++;
            paid++;
        }
        const ranked = Object.values(by).sort((a, b) => b.bets - a.bets || b.wagered - a.wagered);
        for (const e of ranked) e.roi = e.wagered > 0 ? (e.pl / e.wagered) * 100 : 0;
        const main = ranked[0] || { cur: 'usd', pl: 0, wagered: 0, bets: 0, roi: 0 };
        return {
            pl: main.pl, wagered: main.wagered, cur: main.cur, bets: main.bets,
            roi: main.roi, others: ranked.slice(1), paid
        };
    }

    root.VantedgeMoney = {
        CURRENCY_DECIMALS, CURRENCY_SYMBOLS,
        curKey, curDecimals, curEpsilon, fmtMoney,
        betStake, betProfit, summarize
    };
})(typeof self !== 'undefined' ? self : this);
