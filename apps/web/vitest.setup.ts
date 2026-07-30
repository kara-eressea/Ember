// Component-render tier setup (issue #268): the web suite is mostly pure
// unit tests that run under the default node environment; files that render
// React opt in per-file with a `// @vitest-environment jsdom` docblock. This
// setup runs for every test file — it registers the jest-dom matchers and
// unmounts anything a render test mounted, both no-ops for the node tests.
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
