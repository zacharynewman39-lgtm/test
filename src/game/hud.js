// DOM overlay: crosshair, ammo, health, objectives, prompts, damage, menus.

const CSS = `
#hud { position: fixed; inset: 0; pointer-events: none; user-select: none; font-family: 'Courier New', ui-monospace, monospace; color: #e8e2d4; }
#hud .xh { position: absolute; left: 50%; top: 50%; width: 0; height: 0; transition: opacity .1s; }
#hud .xh i { position: absolute; background: #f2eee0; box-shadow: 0 0 2px #000; }
#hud .xh .dot { width: 2px; height: 2px; left: -1px; top: -1px; }
#hud .hit { position: absolute; left: 50%; top: 50%; width: 22px; height: 22px; margin: -11px; opacity: 0; transition: opacity .15s; }
#hud .hit::before, #hud .hit::after { content: ''; position: absolute; left: 10px; top: -2px; width: 2px; height: 26px; background: #fff; transform: rotate(45deg); }
#hud .hit::after { transform: rotate(-45deg); }
#hud .hit.kill::before, #hud .hit.kill::after { background: #d01010; }
#hud .ammo { position: absolute; right: 28px; bottom: 24px; text-align: right; text-shadow: 0 1px 3px #000; }
#hud .ammo b { font-size: 40px; font-weight: 700; }
#hud .ammo span { font-size: 18px; opacity: .7; }
#hud .ammo small { display: block; font-size: 12px; letter-spacing: 2px; opacity: .75; }
#hud .hp { position: absolute; left: 28px; bottom: 28px; width: 220px; text-shadow: 0 1px 3px #000; font-size: 12px; letter-spacing: 2px; }
#hud .hp .bar { height: 6px; background: #0008; margin-top: 6px; border: 1px solid #fff3; }
#hud .hp .bar div { height: 100%; background: #c9c3b3; transition: width .2s; }
#hud .obj { position: absolute; left: 28px; top: 24px; font-size: 13px; line-height: 1.7; text-shadow: 0 1px 3px #000; letter-spacing: 1px; }
#hud .obj .done { opacity: .45; text-decoration: line-through; }
#hud .prompt { position: absolute; left: 50%; top: 58%; transform: translateX(-50%); font-size: 14px; text-shadow: 0 1px 3px #000; letter-spacing: 1px; }
#hud .prompt .prog { width: 160px; height: 4px; background: #0008; margin: 6px auto 0; }
#hud .prompt .prog div { height: 100%; background: #e8e2d4; }
#hud .warn { position: absolute; left: 50%; top: 22%; transform: translateX(-50%); font-size: 18px; color: #ff4a3a; letter-spacing: 2px; text-shadow: 0 0 8px #000; opacity: 0; transition: opacity .3s; font-weight: 700; }
#hud .feed { position: absolute; right: 28px; top: 24px; text-align: right; font-size: 12px; line-height: 1.8; letter-spacing: 1px; text-shadow: 0 1px 3px #000; }
#hud .vig { position: absolute; inset: 0; background: radial-gradient(ellipse at center, transparent 45%, rgba(120,0,0,.85) 100%); opacity: 0; }
#hud .splat { position: absolute; inset: 0; opacity: 0; background:
  radial-gradient(circle at 12% 20%, rgba(90,0,0,.7) 0 6%, transparent 9%),
  radial-gradient(circle at 85% 75%, rgba(90,0,0,.6) 0 5%, transparent 8%),
  radial-gradient(circle at 70% 12%, rgba(90,0,0,.5) 0 3%, transparent 6%); }
#hud .dmgdir { position: absolute; left: 50%; top: 50%; width: 0; height: 0; }
#hud .dmgdir i { position: absolute; left: -40px; top: -190px; width: 80px; height: 26px; background: radial-gradient(ellipse at center, rgba(220,20,10,.85), transparent 70%); opacity: 0; transition: opacity .6s; }
#overlay { position: fixed; inset: 0; display: grid; place-items: center; background: rgba(0,0,0,.82); color: #e8e2d4; font-family: 'Courier New', ui-monospace, monospace; z-index: 5; cursor: pointer; }
#overlay .box { max-width: 640px; padding: 24px; text-align: center; }
#overlay h1 { font-size: 64px; letter-spacing: 10px; margin: 0 0 4px; color: #b80d0d; text-shadow: 0 0 24px #600; font-weight: 700; }
#overlay h2 { font-size: 15px; letter-spacing: 4px; font-weight: 400; opacity: .7; margin: 0 0 28px; }
#overlay p { font-size: 13px; line-height: 1.8; opacity: .85; }
#overlay table { margin: 18px auto; font-size: 13px; border-collapse: collapse; }
#overlay td { padding: 4px 18px; text-align: left; }
#overlay td + td { text-align: right; }
#overlay .rank { font-size: 72px; color: #c9c3b3; }
#overlay .go { margin-top: 26px; font-size: 14px; letter-spacing: 3px; animation: blink 1.2s infinite; }
#overlay kbd { border: 1px solid #fff4; padding: 0 5px; border-radius: 3px; font-family: inherit; }
@keyframes blink { 50% { opacity: .35; } }
@media (max-width: 600px) { #overlay h1 { font-size: 40px; letter-spacing: 6px; } }
`;

export class HUD {
  constructor() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    const el = document.createElement('div');
    el.id = 'hud';
    el.innerHTML = `
      <div class="vig"></div><div class="splat"></div>
      <div class="dmgdir"><i></i></div>
      <div class="xh"><i class="dot"></i><i class="l"></i><i class="r"></i><i class="t"></i><i class="b"></i></div>
      <div class="hit"></div>
      <div class="obj"></div>
      <div class="feed"></div>
      <div class="warn"></div>
      <div class="prompt"></div>
      <div class="hp">HEALTH<div class="bar"><div></div></div></div>
      <div class="ammo"><small></small><b>30</b><span>/ 120</span></div>`;
    document.body.appendChild(el);
    this.el = el;
    this.q = (s) => el.querySelector(s);
    this.xh = this.q('.xh');
    this.xhParts = ['l', 'r', 't', 'b'].map((c) => this.q('.xh .' + c));
    this.vigOpacity = 0;
    this.splatOpacity = 0;
    this.feedItems = [];
    this.warnT = 0;
    this.hitT = 0;
    this.overlay = null;
  }

  update(dt, game) {
    const P = game.player, W = game.weapons;
    // crosshair: gap grows with spread, hidden on ADS
    const d = W.def;
    const gap = 6 + (d.hip * (1 + Math.min(P.speed / 3, 1.5) * 1.5)) * 260;
    const [l, r, t, b] = this.xhParts;
    l.style.cssText = `width:8px;height:2px;top:-1px;left:${-gap - 8}px`;
    r.style.cssText = `width:8px;height:2px;top:-1px;left:${gap}px`;
    t.style.cssText = `width:2px;height:8px;left:-1px;top:${-gap - 8}px`;
    b.style.cssText = `width:2px;height:8px;left:-1px;top:${gap}px`;
    this.xh.style.opacity = W.ads > 0.6 || P.sprinting || !P.alive ? 0 : 1;

    const a = W.ammo;
    this.q('.ammo small').textContent = d.name.toUpperCase() + (W.reloading || W.shellLoad ? ' · RELOADING' : '');
    this.q('.ammo b').textContent = a.mag;
    this.q('.ammo span').textContent = ' / ' + a.reserve;
    this.q('.hp .bar div').style.width = Math.max(0, P.hp) + '%';
    this.q('.hp .bar div').style.background = P.hp < 30 ? '#c22' : '#c9c3b3';

    const s = game.stats;
    const hostages = game.hostages;
    const saved = hostages.filter((h) => h.state === 'leaving' || h.state === 'safe').length;
    const lost = hostages.filter((h) => h.dead).length;
    const left = hostages.length - saved - lost;
    this.q('.obj').innerHTML = `
      <div class="${left === 0 ? 'done' : ''}">▸ RESCUE HOSTAGES ${saved}/${hostages.length}${lost ? ` <span style="color:#e33">(${lost} KIA)</span>` : ''}</div>
      <div class="${game.suspectsLeft() === 0 ? 'done' : ''}">▸ NEUTRALIZE ALL SUSPECTS · ${s.kills} DOWN</div>
      <div style="opacity:.55;font-size:11px">${game.roomName()}</div>`;

    this.vigOpacity = Math.max(P.hp < 35 ? 0.35 + 0.15 * Math.sin(performance.now() / 300) : 0, this.vigOpacity - dt * 1.2);
    this.q('.vig').style.opacity = this.vigOpacity;
    this.splatOpacity = Math.max(0, this.splatOpacity - dt * 0.25);
    this.q('.splat').style.opacity = this.splatOpacity;
    this.hitT -= dt;
    if (this.hitT <= 0) this.q('.hit').style.opacity = 0;
    this.warnT -= dt;
    if (this.warnT <= 0) this.q('.warn').style.opacity = 0;
    this.feedItems = this.feedItems.filter((f) => (f.t -= dt) > 0);
    this.q('.feed').innerHTML = this.feedItems.map((f) => `<div style="opacity:${Math.min(1, f.t)}">${f.text}</div>`).join('');
  }

  prompt(text, progress = null) {
    const p = this.q('.prompt');
    if (!text) { p.innerHTML = ''; return; }
    p.innerHTML = text + (progress !== null ? `<div class="prog"><div style="width:${progress * 100}%"></div></div>` : '');
  }

  spatter(amount) { this.splatOpacity = Math.min(1, this.splatOpacity + amount); }

  hitmarker(kill) {
    const h = this.q('.hit');
    h.classList.toggle('kill', !!kill);
    h.style.opacity = 1;
    this.hitT = kill ? 0.35 : 0.12;
  }

  damage(amount, from, player) {
    this.vigOpacity = Math.min(1, this.vigOpacity + amount / 35);
    if (amount > 15) this.splatOpacity = Math.min(1, this.splatOpacity + 0.5);
    if (from) {
      const ang = Math.atan2(from.x - player.pos.x, from.z - player.pos.z);
      const rel = ang - (player.yaw + Math.PI);
      const i = this.q('.dmgdir i');
      this.q('.dmgdir').style.transform = `rotate(${-rel}rad)`;
      i.style.transition = 'none';
      i.style.opacity = 1;
      requestAnimationFrame(() => { i.style.transition = 'opacity .8s'; i.style.opacity = 0; });
    }
  }

  warn(text, time = 2.5) {
    const w = this.q('.warn');
    w.textContent = text;
    w.style.opacity = 1;
    this.warnT = time;
  }

  feed(text) { this.feedItems.unshift({ text, t: 4 }); this.feedItems.length = Math.min(this.feedItems.length, 6); }

  show(html, onClick) {
    this.hide();
    const o = document.createElement('div');
    o.id = 'overlay';
    o.innerHTML = `<div class="box">${html}</div>`;
    if (onClick) o.addEventListener('click', onClick);
    document.body.appendChild(o);
    this.overlay = o;
  }
  hide() { this.overlay?.remove(); this.overlay = null; }
}
