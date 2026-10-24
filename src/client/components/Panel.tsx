import type { ReactNode } from 'react';

interface PanelProps {
  title: string;
  eyebrow?: string;
  count?: number | string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}

export function Panel({
  title,
  eyebrow,
  count,
  action,
  children,
  className,
  bodyClassName,
}: PanelProps) {
  return (
    <section className={`panel${className ? ` ${className}` : ''}`}>
      <header className="panel-header">
        <div className="panel-heading">
          <span className="panel-mark" aria-hidden="true" />
          <div>
            <h2 className="panel-title">{title}</h2>
            {eyebrow ? <p className="panel-eyebrow">{eyebrow}</p> : null}
          </div>
          {count !== undefined ? <span className="panel-count">{count}</span> : null}
        </div>
        {action ? <div className="panel-action">{action}</div> : null}
      </header>
      <div className={`panel-body${bodyClassName ? ` ${bodyClassName}` : ''}`}>{children}</div>
    </section>
  );
}
