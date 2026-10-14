import { expect, test } from "@playwright/test";
import { dashboardConformanceReferences } from "../apps/dashboard/src/design-conformance";

for (const theme of dashboardConformanceReferences.themes) {
  test(`native control and scrollbar fallbacks follow the ${theme} theme`, async ({ page }) => {
    await page.addInitScript((savedTheme) => localStorage.setItem("lancerlogin-theme", savedTheme), theme);
    await page.goto("/dashboard");
    await expect(page.locator(".app")).toHaveAttribute("data-theme", theme);

    await page.locator(".app").evaluate((root) => {
      const fixture = document.createElement("section");
      fixture.id = "ui-foundation-fixture";
      fixture.setAttribute("aria-label", "UI foundation test fixture");
      fixture.innerHTML = `
        <button type="button">Fallback button</button>
        <label>Fallback text<input value="Example"></label>
        <label>Fallback select<select><option>Example</option></select></label>
        <label>Fallback notes<textarea>Example</textarea></label>
        <label>Fallback file<input type="file"></label>
        <form class="ui-form"><fieldset><legend>Fallback field group</legend><label>Grouped text<input value="Example"></label></fieldset></form>
        <label style="display:flex;align-items:center;min-height:44px;gap:8px"><input type="checkbox">Fallback checkbox</label>
        <label style="display:flex;align-items:center;min-height:44px;gap:8px"><input type="radio" name="fallback-radio">Fallback radio</label>
        <button type="button" aria-invalid="true">Invalid clock trigger</button>
        <details><summary>Fallback disclosure</summary><p>Details</p></details>
        <div data-scroll-fixture style="width: 8rem; height: 3rem; overflow: scroll"><div style="width: 20rem; height: 8rem"></div></div>
      `;
      root.append(fixture);
    });

    const fixture = page.locator("#ui-foundation-fixture");
    const audit = await fixture.evaluate((root) => {
      const controls = Array.from(root.querySelectorAll<HTMLElement>("button,input:not([type='file']):not([type='checkbox']):not([type='radio']),select,textarea,summary"));
      const scroller = root.querySelector<HTMLElement>("[data-scroll-fixture]")!;
      const styleValues = controls.map((control) => {
        const style = getComputedStyle(control);
        return {
          tag: control.tagName,
          fontFamily: style.fontFamily,
          height: control.getBoundingClientRect().height,
          backgroundColor: style.backgroundColor,
          borderStyle: style.borderStyle,
          borderRadius: style.borderRadius,
        };
      });
      const selectStyle = getComputedStyle(root.querySelector("select")!);
      const checkboxStyle = getComputedStyle(root.querySelector("input[type='checkbox']")!);
      const radioStyle = getComputedStyle(root.querySelector("input[type='radio']")!);
      const invalidStyle = getComputedStyle(root.querySelector("[aria-invalid='true']")!);
      const errorProbe = document.createElement("span");
      errorProbe.style.color = "var(--ui-error)";
      root.append(errorProbe);
      const expectedInvalidBorder = getComputedStyle(errorProbe).color;
      errorProbe.remove();
      const scrollbarStyle = getComputedStyle(scroller) as CSSStyleDeclaration & { scrollbarColor?: string; scrollbarWidth?: string };
      const thumbStyle = getComputedStyle(scroller, "::-webkit-scrollbar-thumb");
      const viewportStyle = getComputedStyle(document.documentElement) as CSSStyleDeclaration & { colorScheme?: string; scrollbarColor?: string; scrollbarWidth?: string };
      const viewportThumbStyle = getComputedStyle(document.documentElement, "::-webkit-scrollbar-thumb");
      const labels = Array.from(root.querySelectorAll("label,legend"), (element) => {
        const style = getComputedStyle(element);
        return { fontFamily: style.fontFamily, fontSize: style.fontSize, letterSpacing: style.letterSpacing };
      });
      return {
        labels,
        controls: styleValues,
        selectBackground: selectStyle.backgroundImage,
        checkbox: { appearance: checkboxStyle.appearance, width: checkboxStyle.width, height: checkboxStyle.height, background: checkboxStyle.backgroundColor },
        radio: { appearance: radioStyle.appearance, width: radioStyle.width, height: radioStyle.height, background: radioStyle.backgroundColor },
        invalidBorder: invalidStyle.borderColor,
        expectedInvalidBorder,
        scrollbarColor: scrollbarStyle.scrollbarColor,
        scrollbarWidth: scrollbarStyle.scrollbarWidth,
        thumbBackground: thumbStyle.backgroundColor,
        viewportColorScheme: viewportStyle.colorScheme,
        viewportScrollbarColor: viewportStyle.scrollbarColor,
        viewportScrollbarWidth: viewportStyle.scrollbarWidth,
        viewportThumbBackground: viewportThumbStyle.backgroundColor,
      };
    });

    for (const control of audit.controls) {
      expect(control.fontFamily).toContain("Roboto");
      expect(control.height, control.tag).toBeGreaterThanOrEqual(44);
      expect(control.backgroundColor, control.tag).not.toBe("rgba(0, 0, 0, 0)");
      expect(control.borderStyle, control.tag).toBe("solid");
      expect(control.borderRadius, control.tag).not.toBe("0px");
    }
    for (const label of audit.labels) {
      expect(label.fontFamily).toContain("Roboto");
      expect(parseFloat(label.fontSize)).toBeGreaterThanOrEqual(16);
      expect(label.letterSpacing).toBe("normal");
    }
    expect(audit.selectBackground).not.toBe("none");
    expect(audit.checkbox.appearance).toBe("none");
    expect(parseFloat(audit.checkbox.width)).toBeGreaterThanOrEqual(20);
    expect(audit.checkbox.width).toBe(audit.checkbox.height);
    expect(audit.radio.appearance).toBe("none");
    expect(parseFloat(audit.radio.width)).toBeGreaterThanOrEqual(20);
    expect(audit.radio.width).toBe(audit.radio.height);
    expect(audit.checkbox.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(audit.radio.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(audit.invalidBorder).toBe(audit.expectedInvalidBorder);
    expect(audit.scrollbarColor).not.toBe("auto");
    expect(audit.scrollbarWidth).toBe("thin");
    expect(audit.thumbBackground).not.toBe("rgba(0, 0, 0, 0)");
    expect(audit.viewportColorScheme).toBe(theme);
    expect(audit.viewportScrollbarColor).not.toBe("auto");
    expect(audit.viewportScrollbarWidth).toBe("thin");
    expect(audit.viewportThumbBackground).not.toBe("rgba(0, 0, 0, 0)");

    const input = fixture.getByRole("textbox", { name: "Fallback text" });
    await input.focus();
    expect(await input.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
  });
}
