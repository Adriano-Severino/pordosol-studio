# 🌅 Por do Sol Studio - IDE Oficial da Linguagem Por do Sol

O **Por do Sol Studio** é a IDE oficial e dedicada para desenvolvimento na linguagem de programação **Por do Sol**, construída sobre a base do Visual Studio Code (Code-OSS) com integração nativa do compilador, interpretador, depurador interativo e servidor de linguagem (LSP).

---

## 🚀 Recursos Nativos Integrados

### 1. Toolchain e SDK Embutidos
A IDE vem pronta para uso ("out-of-the-box"), sem necessidade de instalar compiladores ou configurar variáveis de ambiente separadamente:
- **Compilador Por do Sol (`compilador.exe`):** Embutido em `resources/bin/compilador.exe`.
- **Interpretador e Máquina Virtual (`interpretador.exe`):** Embutido em `resources/bin/interpretador.exe`.
- **Ferramenta de Linha de Comando (`pordosol.exe`):** Embutida em `resources/bin/pordosol.exe`.
- **Biblioteca Padrão (`sistema.pbl`):** Embutida em `resources/stdlib/sistema.pbl`.

### 2. Extensão Nativa Oficial (`extensions/pordosol`)
- **Coloração Sintática Avançada:** Suporte a arquivos `.pr` e `.pds`.
- **Language Server Protocol (LSP):** Autocompletar inteligente, diagnósticos de compilação em tempo real e documentação.
- **Depurador com `F5`:** Pontos de interrupção (breakpoints), inspeção de variáveis locais, avanço passo a passo (`F10`/`F11`).
- **Atalhos Oficiais:**
  - `F5`: Iniciar depuração
  - `Ctrl + F5`: Executar sem depuração
  - `Ctrl + Shift + B`: Compilar projeto / arquivo
  - `F9`: Alternar ponto de interrupção (breakpoint)
  - `F10`: Passo sobre (Step Over)
  - `F11`: Passo para dentro (Step Into)

---

## 🛠️ Como Construir e Empacotar a IDE

### Windows (PowerShell)
```powershell
.\scripts\build-ide.ps1 -Version "0.1.5"
```

### Linux / macOS (Bash)
```bash
chmod +x ./scripts/build-ide.sh
./scripts/build-ide.sh "0.1.5"
```
