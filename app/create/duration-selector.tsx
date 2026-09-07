"use client";

import { durationOptionsFor, estimatedH3CostUsd } from "./constants";
import type { ShowFormat } from "./constants";

interface DurationSelectorProps {
  format: ShowFormat;
  onChange: (v: number) => void;
  value: number;
}

export function DurationSelector({ value, onChange, format }: DurationSelectorProps) {
  const options = durationOptionsFor(format);

  return (
    <div className="flex flex-col gap-2">
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            className={`tone-btn text-left ${active ? "active" : ""}`}
            style={{ fontFamily: "var(--font-space-mono)" }}
            onClick={() => onChange(option.value)}
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs font-bold">{option.label}</span>
              {option.clips !== undefined && (
                <span className={`text-[10px] font-normal normal-case tracking-normal ${active ? "opacity-70" : "text-foreground-muted"}`}>
                  {estimatedH3CostUsd(option.clips)}
                </span>
              )}
            </div>
            <div
              className={`mt-1 text-[10px] font-normal normal-case tracking-normal ${
                active ? "opacity-70" : "text-foreground-muted"
              }`}
            >
              {option.description}
              {option.recommended ? " · recommended" : ""}
            </div>
          </button>
        );
      })}
    </div>
  );
}
