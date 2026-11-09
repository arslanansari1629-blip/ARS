/* Sign-in — instant pass and the Google-style form */

import { mountChrome, signInBypass, signInWithEmail, getSession } from "/assets/app.js";

mountChrome("login");

const params = new URLSearchParams(location.search);
const next = params.get("next") || "/dashboard.html";

if (getSession()) location.replace(next);

document.getElementById("bypassBtn").addEventListener("click", () => {
  signInBypass();
  location.replace(next);
});

const modal = document.getElementById("googleModal");
document.getElementById("googleBtn").addEventListener("click", () => {
  modal.classList.remove("hide");
  document.getElementById("gName").focus();
});
document.getElementById("closeModal").addEventListener("click", () => modal.classList.add("hide"));
document.getElementById("googleForm").addEventListener("submit", (e) => {
  e.preventDefault();
  signInWithEmail(
    document.getElementById("gName").value.trim(),
    document.getElementById("gEmail").value.trim()
  );
  location.replace(next);
});
