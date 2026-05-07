# Contributing to miii-cli

We welcome contributions! miii-cli is a community-driven project, and your help is invaluable whether you're fixing a bug, adding a feature, or improving documentation.

---

### 🚀 How to Contribute

1.  **Fork** the repository.
2.  **Clone** your fork locally.
3.  **Create a new branch** (`git checkout -b feature/my-awesome-feature`).
4.  **Commit** your changes and **Push** to the branch.
5.  **Open a Pull Request (PR)** against the `main` branch.

### 🤝 Guidelines

*   **Code Style:** Please follow standard JavaScript/TypeScript best practices.
*   **Testing:** All new features must include accompanying unit or integration tests.
*   **Documentation:** If you change an API or add complex logic, please update the relevant documentation files.

### 📝 Workflow

*   **Bugs:** If you find a bug, please report it on the Issues page with a clear reproduction guide and expected behavior.
*   **Features:** Before starting a large feature, please open an Issue to discuss the scope and design with the core team.

### 🐛 Bug Reporting

When reporting a bug, please include:

1.  **Title:** A concise summary of the issue.
2.  **Environment:** (e.g., Node.js version, OS, browser)
3.  **Steps to Reproduce:** A numbered list of exact steps to trigger the bug.
4.  **Expected Result:** What should have happened.
5.  **Actual Result:** What actually happened.

***

### 🛠 Development Setup

To work on miii-cli locally, please ensure you have the necessary dependencies installed.

1.  **Install Dependencies:**
    `npm install`

2.  **Common Commands:**
    We use a Makefile to streamline common tasks:

    Development/Live Run:   `make dev` (Runs the application in development mode)
    Build Project:         `make build` (Compiles the TypeScript source code)
    Install Globally:      `make install` (Links the project using `npm link`)
    Clean Build:           `make clean` (Removes compiled output)

### 🧪 Testing

When writing tests, please ensure they cover both the happy path and expected edge cases.