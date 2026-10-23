import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarketingNav } from './MarketingNav';

describe('MarketingNav', () => {
  it('renders desktop navigation links and account actions', () => {
    render(<MarketingNav />);

    expect(screen.getByRole('link', { name: 'CryptoWithAlgo' })).toHaveAttribute('href', '/');
    expect(screen.getAllByRole('link', { name: 'Features' })[0]).toHaveAttribute('href', '/features');
    expect(screen.getAllByRole('link', { name: 'How it works' })[0]).toHaveAttribute('href', '/how-it-works');
    expect(screen.getAllByRole('link', { name: 'Docs' })[0]).toHaveAttribute('href', '/docs');
    expect(screen.getAllByRole('link', { name: 'Blog' })[0]).toHaveAttribute('href', '/blog');
    expect(screen.getAllByRole('link', { name: 'Log in' })[0]).toHaveAttribute('href', '/login');
    expect(screen.getAllByRole('link', { name: 'Create a free account' })[0]).toHaveAttribute('href', '/register');
  });

  it('opens and closes phone menu on button click and returns focus', () => {
    render(<MarketingNav />);

    const toggleButton = screen.getByRole('button', { name: 'Toggle menu' });
    expect(toggleButton).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    fireEvent.click(toggleButton);
    expect(toggleButton).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('menu');
    expect(menu).toBeInTheDocument();

    const menuItems = screen.getAllByRole('menuitem');
    expect(menuItems.length).toBe(6);
    expect(menuItems[0]).toHaveTextContent('Features');
    expect(menuItems[1]).toHaveTextContent('How it works');
    expect(menuItems[2]).toHaveTextContent('Docs');
    expect(menuItems[3]).toHaveTextContent('Blog');
    expect(menuItems[4]).toHaveTextContent('Log in');
    expect(menuItems[5]).toHaveTextContent('Create a free account');

    fireEvent.click(toggleButton);
    expect(toggleButton).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(toggleButton).toHaveFocus();
  });

  it('closes phone menu on Escape key press and returns focus', () => {
    render(<MarketingNav />);

    const toggleButton = screen.getByRole('button', { name: 'Toggle menu' });
    fireEvent.click(toggleButton);
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(toggleButton).toHaveFocus();
  });

  it('closes phone menu when a link inside it is clicked and returns focus', () => {
    render(<MarketingNav />);

    const toggleButton = screen.getByRole('button', { name: 'Toggle menu' });
    fireEvent.click(toggleButton);

    const menuItems = screen.getAllByRole('menuitem');
    fireEvent.click(menuItems[0]);

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(toggleButton).toHaveFocus();
  });
});
