import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface DiagnosticoFerramenta {
    nome: string;
    caminho: string;
    origem: string;
    encontrado: boolean;
}

export interface DiagnosticoToolchain {
    compilador: DiagnosticoFerramenta;
    interpretador: DiagnosticoFerramenta;
}

/**
 * Localiza os binários do compilador e interpretador usando a mesma lógica da ferramenta CLI
 */
export async function localizarBinarios(workspaceFolder?: string): Promise<DiagnosticoToolchain> {
    const raiz = workspaceFolder || (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
    
    return {
        compilador: await localizarExecutavel('compilador', 'PORDOSOL_COMPILADOR_PATH', raiz),
        interpretador: await localizarExecutavel('interpretador', 'PORDOSOL_INTERPRETADOR_PATH', raiz)
    };
}

/**
 * Localiza um executável específico seguindo a ordem de prioridade:
 * 1. Binários embutidos na IDE (Por do Sol Studio)
 * 2. Diretório do usuário (~/.pordosol/tools)
 * 3. Variável de ambiente específica
 * 4. PATH do sistema
 * 5. PORDOSOL_HOME/tools
 * 6. Caminhos relativos ao workspace
 */
async function localizarExecutavel(
    nomeBase: string, 
    variavelEnv: string, 
    workspaceFolder?: string
): Promise<DiagnosticoFerramenta> {
    const nomeExec = nomeExecutavel(nomeBase);
    
    // 0. Verificar binários embutidos diretamente na IDE (Por do Sol Studio)
    try {
        const appRoot = vscode.env.appRoot;
        if (appRoot) {
            const candidatosIde = [
                path.join(appRoot, 'resources', 'bin', nomeExec),
                path.join(appRoot, 'bin', nomeExec),
                path.join(appRoot, '..', 'resources', 'bin', nomeExec),
                path.join(appRoot, '..', 'bin', nomeExec),
                path.join(appRoot, '..', 'resources', 'app', 'bin', nomeExec),
                path.join(appRoot, '..', 'tools', nomeExec)
            ];
            for (const caminho of candidatosIde) {
                if (await arquivoExisteEEhExecutavel(caminho)) {
                    return ok(nomeBase, caminho, 'ide-embutida');
                }
            }
        }
    } catch (e) {
        // Ignora erro ao acessar appRoot
    }

    // 1. Verificar pasta de instalação padrão do usuário (~/.pordosol/tools e ~/.pordosol/bin)
    try {
        const homeDir = os.homedir();
        const candidatosHome = [
            path.join(homeDir, '.pordosol', 'tools', nomeExec),
            path.join(homeDir, '.pordosol', 'bin', nomeExec),
            path.join(homeDir, '.pordosol', nomeExec)
        ];
        for (const caminho of candidatosHome) {
            if (await arquivoExisteEEhExecutavel(caminho)) {
                return ok(nomeBase, caminho, 'home:.pordosol');
            }
        }
    } catch (e) {
        // Ignora erro ao verificar homeDir
    }

    // 2. Verificar variável de ambiente específica
    const envPath = process.env[variavelEnv];
    if (envPath && envPath.trim()) {
        const caminho = path.resolve(envPath.trim());
        if (await arquivoExisteEEhExecutavel(caminho)) {
            return ok(nomeBase, caminho, `env:${variavelEnv}`);
        }
    }
    
    // 3. Buscar no PATH do sistema
    try {
        const whichCmd = process.platform === 'win32' ? 'where' : 'which';
        const { stdout } = await execAsync(`${whichCmd} ${nomeExec}`);
        if (stdout.trim()) {
            const caminho = stdout.trim().split('\n')[0].trim();
            if (await arquivoExisteEEhExecutavel(caminho)) {
                return ok(nomeBase, caminho, 'PATH');
            }
        }
    } catch (e) {
        // which/where falhou, continuar para próximos métodos
    }
    
    // 4. Verificar PORDOSOL_HOME/tools
    const pordosolHome = process.env.PORDOSOL_HOME;
    if (pordosolHome && pordosolHome.trim()) {
        const caminho = path.join(pordosolHome.trim(), 'tools', nomeExec);
        if (await arquivoExisteEEhExecutavel(caminho)) {
            return ok(nomeBase, caminho, 'env:PORDOSOL_HOME/tools');
        }
    }
    
    // 5. Verificar caminhos relativos ao workspace
    if (workspaceFolder) {
        const candidatos = [
            path.join(workspaceFolder, 'resources', 'bin', nomeExec),
            path.join(workspaceFolder, 'compilador-portugues', 'target', 'debug', nomeExec),
            path.join(workspaceFolder, 'compilador-portugues', 'target', 'release', nomeExec),
            path.join(workspaceFolder, 'target', 'release', nomeExec),
            path.join(workspaceFolder, 'target', 'debug', nomeExec),
            path.join(workspaceFolder, 'lib', nomeExec),
            path.join(workspaceFolder, 'tools', nomeExec)
        ];
        
        for (const caminho of candidatos) {
            if (await arquivoExisteEEhExecutavel(caminho)) {
                return ok(nomeBase, caminho, 'workspace');
            }
        }
    }
    
    // 5. Retornar falha com caminho padrão
    return falha(nomeBase, nomeExec, 'não encontrado');
}

/**
 * Verifica se um arquivo existe e é executável
 */
async function arquivoExisteEEhExecutavel(caminho: string): Promise<boolean> {
    try {
        await fs.promises.access(caminho, fs.constants.F_OK | fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * Retorna o nome do executável com extensão apropriada para a plataforma
 */
function nomeExecutavel(nome: string): string {
    return process.platform === 'win32' ? `${nome}.exe` : nome;
}

/**
 * Cria um diagnóstico de sucesso
 */
function ok(nome: string, caminho: string, origem: string): DiagnosticoFerramenta {
    return {
        nome,
        caminho,
        origem,
        encontrado: true
    };
}

/**
 * Cria um diagnóstico de falha
 */
function falha(nome: string, caminho: string, origem: string): DiagnosticoFerramenta {
    return {
        nome,
        caminho,
        origem,
        encontrado: false
    };
}

/**
 * Verifica se a toolchain está completa e pronta para uso
 */
export function toolchainPronta(diag: DiagnosticoToolchain): boolean {
    return diag.compilador.encontrado && diag.interpretador.encontrado;
}

/**
 * Localiza o arquivo .pr correspondente a um arquivo .pbc ou vice-versa
 */
export function encontrarArquivoCorrespondente(caminho: string): string | null {
    const ext = path.extname(caminho).toLowerCase();
    const semExt = caminho.substring(0, caminho.length - ext.length);
    
    if (ext === '.pr') {
        const pbc = semExt + '.pbc';
        if (fs.existsSync(pbc)) {
            return pbc;
        }
    } else if (ext === '.pbc') {
        const pr = semExt + '.pr';
        if (fs.existsSync(pr)) {
            return pr;
        }
    }
    
    return null;
}

/**
 * Verifica se o bytecode precisa ser recompilado comparando timestamps
 */
export async function precisaRecompilar(arquivoPr: string, arquivoPbc: string): Promise<boolean> {
    try {
        const statPr = await fs.promises.stat(arquivoPr);
        const statPbc = await fs.promises.stat(arquivoPbc);
        
        // Se o .pr for mais recente que o .pbc, precisa recompilar
        return statPr.mtime > statPbc.mtime;
    } catch {
        // Se algum arquivo não existir, assume que precisa compilar
        return true;
    }
}