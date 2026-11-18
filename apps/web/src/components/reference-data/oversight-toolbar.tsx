import { Icon } from "@/components/ui/icon";
import { Select, type SelectOption } from "@/components/ui/select";

// The row above the list on בשם מגדל / בשם לקוח: the search box, a status
// filter beside it, and an "X מתוך Y" counter. Below `sm` the filter and the
// counter wrap onto their own lines under the search box so nothing is
// squeezed at 375px.
export function OversightToolbar<F extends string>({
  search,
  onSearchChange,
  searchLabel,
  searchPlaceholder,
  filter,
  onFilterChange,
  filterOptions,
  counter,
}: {
  search: string;
  onSearchChange: (value: string) => void;
  searchLabel: string;
  searchPlaceholder: string;
  filter: F;
  onFilterChange: (value: F) => void;
  filterOptions: readonly SelectOption<F>[];
  // null hides the counter (no day, shop not open, or nobody to count).
  counter: { label: string; done: number; total: number } | null;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <label className="relative block w-full max-w-xs">
        <span className="sr-only">{searchLabel}</span>
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 start-3 flex items-center text-ink-subtle"
        >
          <Icon name="search" className="h-4 w-4" />
        </span>
        <input
          type="search"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={searchPlaceholder}
          className="h-10 w-full rounded-md bg-surface ps-9 pe-3 text-sm text-ink shadow-card ring-1 ring-inset ring-border-strong outline-none transition-colors duration-150 placeholder:text-ink-subtle focus:ring-2 focus:ring-accent/40"
        />
      </label>
      <div className="w-40">
        <Select
          value={filter}
          onChange={onFilterChange}
          options={filterOptions}
          aria-label="סינון לפי סטטוס"
        />
      </div>
      {counter && (
        <p className="text-sm text-ink-muted">
          {`${counter.label}: ${counter.done} מתוך ${counter.total}`}
        </p>
      )}
    </div>
  );
}
