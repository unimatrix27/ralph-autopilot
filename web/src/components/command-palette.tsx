import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { NAV } from "@/lib/nav";

/** Fire this event from anywhere (e.g. the topbar button) to open the palette. */
export const OPEN_COMMAND_PALETTE_EVENT = "ralph:open-command-palette";

/**
 * The ⌘K command palette (epic #106, US 42): keyboard-first jump to any page, and
 * the future home for "answer a question / jump to run #". Foundations wires the
 * navigation commands; later slices register run/issue jumps and write actions.
 *
 * Bound to ⌘K (mac) / Ctrl+K, and to a custom event so non-keyboard affordances can
 * open it too.
 */
export function CommandPalette() {
  const [open, setOpen] = React.useState(false);
  const navigate = useNavigate();

  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    const onOpen = () => setOpen(true);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen);
    };
  }, []);

  const go = React.useCallback(
    (path: string) => {
      setOpen(false);
      void navigate({ to: path });
    },
    [navigate],
  );

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Jump to a page or type a command…" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        <CommandGroup heading="Navigation">
          {NAV.map((item) => (
            <CommandItem key={item.path} value={`${item.label} ${item.description}`} onSelect={() => go(item.path)}>
              <item.Icon className="h-4 w-4 opacity-70" />
              <span>{item.label}</span>
              <span className="text-xs text-muted-foreground">{item.description}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Actions">
          <CommandItem value="answer escalation question inbox" onSelect={() => go("/inbox")}>
            <span>Answer a question</span>
            <CommandShortcut>Inbox</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

/** Small helper for buttons that should open the palette. */
export function openCommandPalette(): void {
  window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT));
}
