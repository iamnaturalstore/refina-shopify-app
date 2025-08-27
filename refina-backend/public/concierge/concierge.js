/* Refina storefront bootstrap (inert): mark root, no network yet */
(function(){
  function findRoot(){
    var el = document.getElementById("root")
      || document.querySelector('[data-refina-root]')
      || document.body;
    if (el && !el.classList.contains("rf-root")) el.classList.add("rf-root");
    return el || document.body;
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", findRoot, { once:true });
  } else {
    findRoot();
  }
})();
