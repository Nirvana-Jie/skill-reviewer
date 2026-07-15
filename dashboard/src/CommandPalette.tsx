import { CornerDownLeft, Search, X } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { useUiPreferences } from "./ui-preferences";

export interface DashboardCommand {
  id: string;
  group: string;
  label: string;
  detail?: string;
  keywords?: string[];
  shortcut?: string;
  run: () => void;
}

export function CommandPalette({
  open,
  commands,
  onClose,
}: {
  open: boolean;
  commands: DashboardCommand[];
  onClose: () => void;
}) {
  const { t } = useUiPreferences();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const visibleCommands = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return commands.slice(0, 18);
    return commands
      .filter((command) =>
        [command.group, command.label, command.detail, ...(command.keywords ?? [])]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase()
          .includes(normalized),
      )
      .slice(0, 18);
  }, [commands, query]);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    setQuery("");
    setActiveIndex(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(timer);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [open]);

  useEffect(() => {
    setActiveIndex((current) =>
      Math.min(current, Math.max(visibleCommands.length - 1, 0)),
    );
  }, [visibleCommands.length]);

  useEffect(() => {
    if (!open || !visibleCommands.length) return;
    document
      .getElementById(`dashboard-command-${visibleCommands[activeIndex]?.id}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, open, visibleCommands]);

  if (!open) return null;

  const execute = (command: DashboardCommand | undefined) => {
    if (!command) return;
    onClose();
    command.run();
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) =>
        visibleCommands.length ? (current + 1) % visibleCommands.length : 0,
      );
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) =>
        visibleCommands.length
          ? (current - 1 + visibleCommands.length) % visibleCommands.length
          : 0,
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      execute(visibleCommands[activeIndex]);
    }
  };

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusables = [inputRef.current, closeRef.current].filter(
      (element): element is HTMLInputElement | HTMLButtonElement => Boolean(element),
    );
    if (!focusables.length) return;
    const currentIndex = focusables.indexOf(
      document.activeElement as HTMLInputElement | HTMLButtonElement,
    );
    const nextIndex = event.shiftKey
      ? (currentIndex - 1 + focusables.length) % focusables.length
      : (currentIndex + 1) % focusables.length;
    event.preventDefault();
    focusables[nextIndex]?.focus();
  };

  return (
    <div
      className="command-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-palette-title"
        onKeyDown={handleDialogKeyDown}
      >
        <header className="command-heading">
          <div>
            <span className="pane-kicker">Skill Reviewer</span>
            <h2 id="command-palette-title">{t("commandPaletteTitle")}</h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label={t("closeCommandPalette")}
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </header>

        <label className="command-search">
          <Search size={16} aria-hidden="true" />
          <input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-label={t("commandPalettePlaceholder")}
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls="dashboard-command-list"
            aria-activedescendant={
              visibleCommands[activeIndex]
                ? `dashboard-command-${visibleCommands[activeIndex].id}`
                : undefined
            }
            value={query}
            placeholder={t("commandPalettePlaceholder")}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleInputKeyDown}
          />
        </label>

        <div
          id="dashboard-command-list"
          className="command-results"
          role="listbox"
          aria-label={t("commandsAvailable")}
        >
          {visibleCommands.map((command, index) => (
            <button
              id={`dashboard-command-${command.id}`}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              tabIndex={-1}
              className={index === activeIndex ? "is-active" : ""}
              key={command.id}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => execute(command)}
            >
              <span className="command-kind">{command.group}</span>
              <span className="command-copy">
                <strong>{command.label}</strong>
                {command.detail && <small>{command.detail}</small>}
              </span>
              {command.shortcut && <kbd>{command.shortcut}</kbd>}
            </button>
          ))}
          {!visibleCommands.length && (
            <div className="command-empty">
              <strong>{t("noCommandsFound")}</strong>
              <p>{t("noCommandsHint")}</p>
            </div>
          )}
        </div>

        <footer className="command-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> {t("navigate")}</span>
          <span><kbd><CornerDownLeft size={10} /></kbd> {t("runCommand")}</span>
          <span><kbd>esc</kbd> {t("close")}</span>
        </footer>
      </section>
    </div>
  );
}
