// Sayfa çizilmeden önce temayı uygula (beyaz yanıp sönme olmasın)
(function () {
  var t = null;
  try { t = localStorage.getItem('wm-theme'); } catch (e) { /* gizli mod */ }
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
})();
