import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Panel } from './Panel';

describe('Panel', () => {
  it('renders heading level 2 by default with title text', () => {
    render(<Panel title="Lab status">Panel content</Panel>);
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading).toHaveTextContent('Lab status');
    expect(heading).toHaveClass('text-ink-2');
    expect(heading).toHaveClass('text-[16px]');
    expect(heading).toHaveClass('font-semibold');
  });

  it('renders heading level 3 when level prop is 3', () => {
    render(
      <Panel title="Sub section" level={3}>
        Panel content
      </Panel>
    );
    const heading = screen.getByRole('heading', { level: 3 });
    expect(heading).toHaveTextContent('Sub section');
  });

  it('renders the action slot aligned right', () => {
    render(
      <Panel
        title="Lab"
        action={<button type="button">Action button</button>}
      >
        Body
      </Panel>
    );
    expect(screen.getByRole('button', { name: 'Action button' })).toBeInTheDocument();
  });

  it('renders as custom element like div or section', () => {
    const { container, rerender } = render(<Panel as="div">Content</Panel>);
    expect(container.querySelector('div.bg-card')).toBeInTheDocument();

    rerender(<Panel as="section">Content</Panel>);
    expect(container.querySelector('section.bg-card')).toBeInTheDocument();
  });

  it('forwards aria-labelledby, data-testid, and id to the rendered section', () => {
    render(
      <Panel
        id="panel-lab"
        data-testid="lab-panel"
        aria-labelledby="lab-heading"
      >
        Panel content
      </Panel>
    );
    const section = screen.getByTestId('lab-panel');
    expect(section.tagName).toBe('SECTION');
    expect(section).toHaveAttribute('id', 'panel-lab');
    expect(section).toHaveAttribute('aria-labelledby', 'lab-heading');
  });
});

