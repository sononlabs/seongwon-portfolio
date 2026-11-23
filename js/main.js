// Nav scroll state — 히어로 핀 구간에서는 배경 없이 두어 체인 클로즈업을 가리지 않는다
const nav = document.getElementById('nav');
const heroPin = document.getElementById('hero-pin');
const updateNav = () => {
  const pinned = document.documentElement.classList.contains('hero-pinned');
  const threshold = pinned && heroPin ? heroPin.offsetTop + heroPin.offsetHeight - innerHeight - 40 : 10;
  nav.classList.toggle('scrolled', window.scrollY > threshold);
};
window.addEventListener('scroll', updateNav, { passive: true });
window.addEventListener('resize', updateNav);

// Hero pin: 처음엔 펜으로 그려지는 고리만 보이고, 스크롤 진행도에 따라 제목 요소가 차례로 올라온다
const pin = document.getElementById('hero-pin');
if (pin) {
  const items = [...pin.querySelectorAll('[data-reveal]')];
  const cue = pin.querySelector('.scroll-cue');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const clamp = (v) => Math.min(1, Math.max(0, v));
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const update = () => {
    const pinned = !reduce.matches && innerWidth >= 720 && innerHeight >= 620;
    document.documentElement.classList.toggle('hero-pinned', pinned);
    let p = 1;
    if (pinned) {
      const r = pin.getBoundingClientRect();
      p = clamp(-r.top / (r.height - innerHeight));
    }
    // 앞 30%는 펜이 고리를 그려 철로 만드는 구간(chain.js), 제목은 그 뒤에 올라온다
    items.forEach((el, i) => el.style.setProperty('--t', ease(clamp((p - 0.34 - i * 0.07) / 0.18)).toFixed(4)));
    if (cue) cue.style.opacity = String(1 - clamp(p / 0.06));
  };
  addEventListener('scroll', update, { passive: true });
  addEventListener('resize', update);
  update();
}
updateNav();

// Reveal on scroll
const revealEls = document.querySelectorAll('.reveal');
const io = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add('in');
      io.unobserve(entry.target);
    }
  });
}, { threshold: 0.12 });
revealEls.forEach((el) => io.observe(el));
