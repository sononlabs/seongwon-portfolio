// Nav scroll state
const nav = document.getElementById('nav');
window.addEventListener('scroll', () => {
  nav.classList.toggle('scrolled', window.scrollY > 10);
}, { passive: true });

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

// Project card expand/collapse
document.querySelectorAll('[data-card]').forEach((card) => {
  card.addEventListener('click', (e) => {
    if (e.target.closest('a')) return; // allow outbound links to work normally
    const wasOpen = card.classList.contains('is-open');
    document.querySelectorAll('[data-card].is-open').forEach((c) => {
      if (c !== card) c.classList.remove('is-open');
    });
    card.classList.toggle('is-open', !wasOpen);
    const toggle = card.querySelector('.proj-toggle');
    if (toggle) toggle.textContent = !wasOpen ? '접기 ▴' : '자세히 보기 ▾';
  });
});
