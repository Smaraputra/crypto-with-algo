import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from './card';

describe('Card', () => {
  it('renders Card with all subcomponents', () => {
    render(
      <Card data-testid="card">
        <CardHeader>
          <CardTitle>Title</CardTitle>
          <CardDescription>Description</CardDescription>
        </CardHeader>
        <CardContent>Content</CardContent>
        <CardFooter>Footer</CardFooter>
      </Card>
    );

    expect(screen.getByTestId('card')).toBeInTheDocument();
    expect(screen.getByText('Title')).toBeInTheDocument();
    expect(screen.getByText('Description')).toBeInTheDocument();
    expect(screen.getByText('Content')).toBeInTheDocument();
    expect(screen.getByText('Footer')).toBeInTheDocument();
  });

  it('applies correct data-slot attributes', () => {
    render(
      <Card data-testid="card">
        <CardHeader data-testid="header">
          <CardTitle data-testid="title">Title</CardTitle>
          <CardDescription data-testid="desc">Desc</CardDescription>
        </CardHeader>
        <CardContent data-testid="content">Content</CardContent>
        <CardFooter data-testid="footer">Footer</CardFooter>
      </Card>
    );

    expect(screen.getByTestId('card')).toHaveAttribute('data-slot', 'card');
    expect(screen.getByTestId('header')).toHaveAttribute('data-slot', 'card-header');
    expect(screen.getByTestId('title')).toHaveAttribute('data-slot', 'card-title');
    expect(screen.getByTestId('desc')).toHaveAttribute('data-slot', 'card-description');
    expect(screen.getByTestId('content')).toHaveAttribute('data-slot', 'card-content');
    expect(screen.getByTestId('footer')).toHaveAttribute('data-slot', 'card-footer');
  });

  it('merges custom className on Card', () => {
    render(<Card data-testid="card" className="custom-card">Content</Card>);
    expect(screen.getByTestId('card').className).toContain('custom-card');
  });

  it('merges custom className on CardContent', () => {
    render(<CardContent data-testid="content" className="custom-content">Content</CardContent>);
    expect(screen.getByTestId('content').className).toContain('custom-content');
  });

  it('passes through HTML attributes', () => {
    render(<Card data-testid="card" role="region" aria-label="test card">Content</Card>);
    const card = screen.getByTestId('card');
    expect(card).toHaveAttribute('role', 'region');
    expect(card).toHaveAttribute('aria-label', 'test card');
  });
});
