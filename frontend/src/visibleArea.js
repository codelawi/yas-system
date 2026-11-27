/*
 * The part of the screen the keyboard leaves visible. A phone's keyboard covers the bottom of the
 * page without resizing it, and the browser pans to keep the text box in sight; dialogs come up from
 * the bottom (phone.css), so they follow this area and sit just above the keyboard.
 */
export function followVisibleArea() {
  const area = window.visualViewport
  if (!area) return
  const root = document.documentElement
  const update = () => {
    root.style.setProperty('--visible-top', `${area.offsetTop}px`)
    root.style.setProperty('--visible-height', `${area.height}px`)
  }
  update()
  area.addEventListener('resize', update)
  area.addEventListener('scroll', update)
}
