import type { ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import type { BadgeTone } from "./Badge.js";

export type SurfaceTone = "surface" | "soft" | "accent" | "mint" | "warm";

export function Card({
  as: Tag = "div",
  tone = "surface",
  padded = true,
  className,
  children,
}: {
  as?: "div" | "section" | "article";
  tone?: SurfaceTone;
  padded?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tag
      className={[
        "ui-card",
        `ui-card--${tone}`,
        padded ? "ui-card--padded" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </Tag>
  );
}

export function SectionHeading({
  title,
  count,
  description,
  action,
  level = 2,
  className,
}: {
  title: ReactNode;
  count?: number;
  description?: ReactNode;
  action?: ReactNode;
  level?: 2 | 3;
  className?: string;
}) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <div className={`ui-section-heading${className ? ` ${className}` : ""}`}>
      <div className="ui-section-heading__copy">
        <Heading>
          {title}
          {typeof count === "number" && count > 0 && (
            <span className="ui-section-heading__count">{count}</span>
          )}
        </Heading>
        {description && <p>{description}</p>}
      </div>
      {action && <div className="ui-section-heading__action">{action}</div>}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  tone = "neutral",
  inline = false,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  tone?: BadgeTone;
  inline?: boolean;
  className?: string;
}) {
  return (
    <div
      className={[
        "ui-empty",
        `ui-empty--${tone}`,
        inline ? "ui-empty--inline" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {icon && <span className="ui-empty__icon">{icon}</span>}
      <div className="ui-empty__copy">
        <h3>{title}</h3>
        {description && <p>{description}</p>}
      </div>
      {action && <div className="ui-empty__action">{action}</div>}
    </div>
  );
}

export function LoadingState({
  label,
  inline = false,
}: {
  label: ReactNode;
  inline?: boolean;
}) {
  return (
    <span
      className={`ui-loading${inline ? " ui-loading--inline" : ""}`}
      role="status"
      aria-live="polite"
    >
      <LoaderCircle className="ui-loading__mark" size={14} aria-hidden="true" />
      {label}
    </span>
  );
}

export function SettingsSection({
  icon,
  title,
  description,
  children,
  actions,
  wide = false,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  wide?: boolean;
  className?: string;
}) {
  return (
    <Card
      as="section"
      padded={false}
      className={[
        "ui-settings-card",
        wide ? "ui-settings-card--wide" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <header className="ui-settings-card__head">
        {icon && <span className="ui-settings-card__icon">{icon}</span>}
        <div>
          <h3>{title}</h3>
          {description && <p>{description}</p>}
        </div>
      </header>
      {children && <div className="ui-settings-card__body">{children}</div>}
      {actions && <div className="ui-settings-card__actions">{actions}</div>}
    </Card>
  );
}
