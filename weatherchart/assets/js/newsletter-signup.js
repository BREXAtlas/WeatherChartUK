const SIGNUP_ENDPOINT = "https://rceqidouaazdlimtivfq.supabase.co/functions/v1/weather-tips-signup";

document.querySelectorAll("[data-weather-signup]").forEach((form) => {
  const status = form.querySelector("[data-signup-status]");
  const button = form.querySelector("button[type='submit']");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const email = String(data.get("email") || "").trim();
    const consent = data.get("consent") === "on";
    const company = String(data.get("company") || "").trim();

    if (!email || !consent) {
      status.textContent = "Enter your email and tick the consent box.";
      return;
    }

    button.disabled = true;
    status.textContent = "Saving your signup…";

    try {
      const response = await fetch(SIGNUP_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          consent,
          company,
          site: "weatherchart",
          sourceUrl: window.location.href,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Signup failed");

      form.reset();
      status.textContent = "You’re on the list. The forecast may wobble, but your signup is safely stored.";
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "We could not save your signup. Please try again.";
    } finally {
      button.disabled = false;
    }
  });
});
