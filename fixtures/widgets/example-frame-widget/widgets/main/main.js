// Renders the `title` prop inside a frame. The host passes props through the injected widget bootstrap; this code
// never reaches the network or the host page.
const root = document.getElementById("root");

function render(props) {
  const frame = document.createElement("section");
  frame.style.border = "1px solid currentColor";
  frame.style.borderRadius = "10px";
  frame.style.padding = "16px";
  const heading = document.createElement("h1");
  heading.textContent = typeof props?.title === "string" ? props.title : "Untitled frame";
  frame.append(heading);
  root.replaceChildren(frame);
}

render(globalThis.clarkcant?.props ?? {});
globalThis.clarkcant?.onProps?.(render);
