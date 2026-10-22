// before first paint, so dark mode doesn't flash. a file, not inline: the content security policy allows scripts from this origin only
const dark = matchMedia("(prefers-color-scheme: dark)")
const apply = () => (document.documentElement.dataset.mode = dark.matches ? "dark" : "light")
apply()
dark.addEventListener("change", apply)
