// SpireLink のイベント列から、現在のデッキ・レリック・ポーションと取得履歴を組み立てる
(function (root) {
  function norm(id) {
    if (!id) return { key: '', upgraded: false };
    var s = String(id).replace(/^(CARD|RELIC|POTION|CHARACTER)\./, '');
    var up = false;
    var m = s.match(/\+(\d*)$/);
    if (m) { up = true; s = s.slice(0, m.index); }
    return { key: s, upgraded: up };
  }
  function isUpgraded(card) {
    if (!card) return false;
    if (card.upgraded === true) return true;
    if (typeof card.upgradeLevel === 'number' && card.upgradeLevel > 0) return true;
    if (typeof card.upgrades === 'number' && card.upgrades > 0) return true;
    if (typeof card.timesUpgraded === 'number' && card.timesUpgraded > 0) return true;
    return norm(card.id).upgraded;
  }
  function playerOf(m) {
    if (m.players && m.players[0]) return m.players[0];
    if (m.context && m.context.player) return m.context.player;
    return null;
  }

  function build(events) {
    var ev = events.map(function (e) { return e.msg || e; })
      .filter(function (m) { return m && m.type; })
      .sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); });

    var deck = [];      // {key, upgraded, floor, src, seq}
    var relics = [];    // {key, floor, src}
    var history = [];   // {floor, kind, key, src, seq, upgraded}
    var snap = null;    // 最新のプレイヤー状態
    var potions = null, potSeq = -1;
    var gold = null, hp = null, maxHp = null;
    var started = false;
    var curFloor = 1;

    function addCard(card, floor, src, seq, initial) {
      var n = norm(card.id);
      var item = { key: n.key, upgraded: isUpgraded(card), floor: floor, src: src, seq: seq };
      deck.push(item);
      if (!initial) history.push({ floor: floor, kind: 'add', key: n.key, upgraded: item.upgraded, src: src, seq: seq });
    }
    function removeCard(card, floor, src, seq) {
      var n = norm(card.id);
      var up = isUpgraded(card);
      var idx = -1;
      for (var i = 0; i < deck.length; i++) if (deck[i].key === n.key && deck[i].upgraded === up) { idx = i; break; }
      if (idx < 0) for (var j = 0; j < deck.length; j++) if (deck[j].key === n.key) { idx = j; break; }
      if (idx >= 0) deck.splice(idx, 1);
      history.push({ floor: floor, kind: 'remove', key: n.key, upgraded: up, src: src, seq: seq });
    }
    function addRelic(id, floor, src, seq, initial) {
      var k = norm(id).key;
      for (var i = 0; i < relics.length; i++) if (relics[i].key === k) return;
      relics.push({ key: k, floor: floor, src: src });
      if (!initial) history.push({ floor: floor, kind: 'relic', key: k, src: src, seq: seq });
    }

    var reconciled = 0;
    // その時点のデッキ（スナップショット）と枚数が合わなければ、その階で増減があったものとして補正する
    function reconcileCounts(snapDeck, floor, seq) {
      var expect = {}, have = {};
      snapDeck.forEach(function (c) { var k = norm(c.id).key; expect[k] = (expect[k] || 0) + 1; });
      deck.forEach(function (d) { have[d.key] = (have[d.key] || 0) + 1; });
      Object.keys(expect).forEach(function (k) {
        for (var i = 0; i < expect[k] - (have[k] || 0); i++) {
          deck.push({ key: k, upgraded: false, floor: floor, src: 'unknown', seq: seq });
          history.push({ floor: floor, kind: 'add', key: k, src: '', seq: seq });
          reconciled++;
        }
      });
      Object.keys(have).forEach(function (k) {
        for (var i = 0; i < have[k] - (expect[k] || 0); i++) {
          for (var j = deck.length - 1; j >= 0; j--) if (deck[j].key === k) { deck.splice(j, 1); break; }
          history.push({ floor: floor, kind: 'remove', key: k, src: '', seq: seq });
          reconciled++;
        }
      });
    }

    ev.forEach(function (m) {
      if (typeof m.floor === 'number') curFloor = m.floor;
      var f = typeof m.floor === 'number' ? m.floor : curFloor;
      var p = playerOf(m);

      if (m.type === 'run_state' && !started && p && p.deck) {
        started = true;
        p.deck.forEach(function (c) { addCard(c, f, 'start', m.seq, true); });
        (p.relics || []).forEach(function (r) { addRelic(r, f, 'start', m.seq, true); });
      }
      if (m.type === 'card_added' && m.newPile === 'Deck' && !m.inCombat && m.card) {
        addCard(m.card, f, m.context || 'other', m.seq, false);
      }
      if (m.type === 'card_removed' && m.card) {
        removeCard(m.card, f, m.context || 'other', m.seq);
      }
      if ((/upgrad|smith/i.test(m.type)) && m.card) {
        var n = norm(m.card.id);
        for (var i = 0; i < deck.length; i++) if (deck[i].key === n.key && !deck[i].upgraded) { deck[i].upgraded = true; break; }
        history.push({ floor: f, kind: 'upgrade', key: n.key, src: m.context || '', seq: m.seq });
      }
      if (m.type === 'relic_obtained' && m.relicId) {
        addRelic(m.relicId, f, m.roomType || 'other', m.seq, false);
      }
      if (p) {
        if (started && p.deck) reconcileCounts(p.deck, f, m.seq);
        snap = { seq: m.seq, floor: f, p: p };
        if (p.relics) p.relics.forEach(function (r) { addRelic(r, f, 'unknown', m.seq, !started); });
      }
      var pots = m.potions || (p && p.potions);
      if (Array.isArray(pots) && (m.seq || 0) >= potSeq) { potions = pots; potSeq = m.seq || 0; }
      var g = (typeof m.gold === 'number') ? m.gold : (m.goldRemaining != null ? m.goldRemaining : (p && typeof p.gold === 'number' ? p.gold : null));
      if (g != null) gold = g;
      // HP: プレイヤーの状態か、プレイヤー自身の hp_changed / rest_site_heal だけを使う
      var isPlayerHp = m.type === 'rest_site_heal' ||
        (m.type === 'hp_changed' && /^CHARACTER\./.test(m.creatureId || ''));
      if (p && typeof p.hp === 'number') { hp = p.hp; if (typeof p.maxHp === 'number') maxHp = p.maxHp; }
      else if (isPlayerHp && typeof m.hp === 'number') { hp = m.hp; if (typeof m.maxHp === 'number') maxHp = m.maxHp; }
    });

    // 最新スナップショットとの照合（強化状態・レリック）
    if (snap && snap.p.deck) {
      // 強化状態もスナップショットに合わせる（イベント経由の強化などの取りこぼし対策）
      var upCount = {};
      snap.p.deck.forEach(function (c) { if (isUpgraded(c)) { var k = norm(c.id).key; upCount[k] = (upCount[k] || 0) + 1; } });
      ev.forEach(function (m) {
        if ((m.seq || 0) <= snap.seq) return;
        if (m.type === 'card_added' && m.newPile === 'Deck' && !m.inCombat && m.card && isUpgraded(m.card)) { var k = norm(m.card.id).key; upCount[k] = (upCount[k] || 0) + 1; }
        if ((/upgrad|smith/i.test(m.type)) && m.card) { var k3 = norm(m.card.id).key; upCount[k3] = (upCount[k3] || 0) + 1; }
      });
      var seen = {};
      deck.forEach(function (d) { var n = seen[d.key] = (seen[d.key] || 0) + 1; d.upgraded = n <= (upCount[d.key] || 0); });

      // スナップショットにないレリックは外す（交換・消滅など）
      var snapRel = (snap.p.relics || []).map(function (r) { return norm(r).key; });
      ev.forEach(function (m) { if ((m.seq || 0) > snap.seq && m.type === 'relic_obtained' && m.relicId) snapRel.push(norm(m.relicId).key); });
      relics = relics.filter(function (r) { return snapRel.indexOf(r.key) >= 0; });
    }

    return {
      deck: deck,
      relics: relics,
      potions: (potions || []).map(function (x) { return x ? norm(x).key : null; }),
      history: history.sort(function (a, b) { return b.seq - a.seq; }),
      gold: gold, hp: hp, maxHp: maxHp, floor: curFloor,
      reconciled: reconciled
    };
  }

  var api = { build: build, norm: norm };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DeckBuilder = api;
})(this);
