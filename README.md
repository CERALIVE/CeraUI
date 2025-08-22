# Cera Workspace

A monorepo containing multiple related projects managed with pnpm workspaces.

## Structure

```
cera-workspace/
├── apps/                   # Applications
│   ├── frontend/          # CeraUI Svelte application
│   └── [your-second-app]/ # Space for your second repository
├── packages/              # Shared packages (if needed)
└── package.json           # Workspace configuration
```

## Getting Started

### Install dependencies for all projects:
```bash
pnpm install
```

### Development commands:

#### Run all projects in development:

**Option 1: mprocs (Recommended - Better UI)**
```bash
pnpm dev
```
*Provides a beautiful TUI with separate panes for each process*

**Option 2: Parallel execution**
```bash
pnpm dev:parallel
```
*Traditional parallel execution with mixed output*

#### Run specific project:
```bash
pnpm frontend:dev
# or when you add your second project:
# pnpm [second-app-name]:dev
```

#### Build all projects:
```bash
pnpm build
```

#### Build specific project:
```bash
pnpm frontend:build
```

## Adding Your Second Repository

### Option 1: Manual Integration
1. Create a new directory in `apps/` for your second project:
   ```bash
   mkdir apps/[your-project-name]
   ```

2. Copy your second repository files into the new directory

3. Update your second project's `package.json`:
   - Change the name to match the directory name
   - Add a "clean" script if desired

4. Add workspace scripts for your new project in the root `package.json`:
   ```json
   {
     "scripts": {
       "[project-name]:dev": "pnpm --filter [project-name] run dev",
       "[project-name]:build": "pnpm --filter [project-name] run build"
     }
   }
   ```

### Option 2: Git Subtree (Preserves History)
```bash
# Add your second repository as a subtree
git subtree add --prefix=apps/[your-project-name] [your-repo-url] [branch] --squash

# To pull updates from the original repository later:
git subtree pull --prefix=apps/[your-project-name] [your-repo-url] [branch] --squash
```

### Option 3: Git Remote + Manual Merge
```bash
# Add the second repository as a remote
git remote add second-repo [your-repo-url]
git fetch second-repo

# Create a new branch for merging
git checkout -b merge-second-repo
git read-tree --prefix=apps/[your-project-name]/ -u second-repo/[branch]
git commit -m "Add second repository to workspace"
```

## Project-Specific Commands

### Frontend (Svelte App)
```bash
# Development with hot reload
pnpm frontend:dev

# Development accessible from network
cd apps/frontend && pnpm dev:host

# Build for production
pnpm frontend:build

# Preview production build
pnpm frontend:preview
```

## Workspace Management

### Install dependency for specific project:
```bash
pnpm --filter frontend add [package-name]
pnpm --filter [second-app] add [package-name]
```

### Install shared dependency at root:
```bash
pnpm add -w [package-name]
```

### Run commands in all projects:
```bash
pnpm --recursive run [script-name]
```

### Clean everything:
```bash
pnpm clean
```

## mprocs Configuration

The workspace uses mprocs for an enhanced development experience. Configuration is in `mprocs.yaml`:

### mprocs Keyboard Shortcuts:
- **Tab/Shift+Tab**: Navigate between processes
- **r**: Restart current process
- **k**: Kill current process  
- **c**: Clear current process logs
- **q**: Quit mprocs

### Adding New Apps to mprocs:
When you add a new app, update `mprocs.yaml`:
```yaml
procs:
  frontend:
    cwd: "./apps/frontend"
    cmd: ["pnpm", "dev"]
  
  your-new-app:
    cwd: "./apps/your-new-app"
    cmd: ["pnpm", "dev"]
    env:
      NODE_ENV: development
```

## Notes

- Each project in `apps/` is independent and can have its own dependencies
- Shared packages can be placed in `packages/` if needed
- All projects share the same Node.js version (22.11.0) via Volta
- Use pnpm for all package management to maintain workspace integrity
- Use `pnpm dev` for the best development experience with mprocs TUI