import * as path from 'path';
import { workspace, ExtensionContext } from 'vscode';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind
} from 'vscode-languageclient/node';
import * as vscode from 'vscode';
import { registerDebugAdapter } from './debugAdapter';
import { localizarBinarios, toolchainPronta, precisaRecompilar } from './toolchain';
import { spawn } from 'child_process';
import * as fs from 'fs';

let client: LanguageClient;

export async function activate(context: ExtensionContext) {
    console.log('[Por Do Sol Extension] Ativando extensão...');

    // Caminho do servidor
    const serverModule = context.asAbsolutePath(
        path.join('server', 'out', 'server.js')
    );

    // Opções de debug
    const debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };

    // Configuração do servidor
    const serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: {
            module: serverModule,
            transport: TransportKind.ipc,
            options: debugOptions
        }
    };

    // Configuração do cliente
    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: 'pordosol' }],
        synchronize: {
            fileEvents: workspace.createFileSystemWatcher('**/.pordosolrc')
        }
    };

    // Criar e iniciar o cliente
    client = new LanguageClient(
        'pordosolLanguageServer',
        'Por Do Sol Language Server',
        serverOptions,
        clientOptions
    );

    // Iniciar o cliente
    client.start();
    console.log('[Por Do Sol Extension] Language Server iniciado');

    // Registrar Debug Adapter (MVP)
    registerDebugAdapter(context);
    console.log('[Por Do Sol Extension] Debug Adapter registrado');

    // Registrar comando de execução sem debug
    const runCommand = vscode.commands.registerCommand('pordosol.runWithoutDebug', async () => {
        console.log('[Por Do Sol Extension] Comando runWithoutDebug executado');
        await runWithoutDebug();
    });
    context.subscriptions.push(runCommand);
    console.log('[Por Do Sol Extension] Comando pordosol.runWithoutDebug registrado');

    // Registrar comando para iniciar debug
    const debugCommand = vscode.commands.registerCommand('pordosol.startDebug', async () => {
        console.log('[Por Do Sol Extension] Comando startDebug executado');
        await startDebug();
    });
    context.subscriptions.push(debugCommand);
    console.log('[Por Do Sol Extension] Comando pordosol.startDebug registrado');

    // Registrar comando para compilar
    const compileCommand = vscode.commands.registerCommand('pordosol.compile', async () => {
        console.log('[Por Do Sol Extension] Comando compile executado');
        await compileFile();
    });
    context.subscriptions.push(compileCommand);
    console.log('[Por Do Sol Extension] Comando pordosol.compile registrado');

    // Registrar comando para criar configuração de debug
    const createLaunchConfigCommand = vscode.commands.registerCommand('pordosol.createLaunchConfig', async () => {
        console.log('[Por Do Sol Extension] Comando createLaunchConfig executado');
        await createLaunchConfiguration();
    });
    context.subscriptions.push(createLaunchConfigCommand);
    console.log('[Por Do Sol Extension] Comando pordosol.createLaunchConfig registrado');

    // Detectar e criar configuração automaticamente se necessário
    await detectAndCreateLaunchConfiguration();

    console.log('[Por Do Sol Extension] Ativação concluída com sucesso');
}

export function deactivate(): Promise<void> | undefined {
    if (!client) {
        return undefined;
    }
    return client.stop();
}

/**
 * Executa o arquivo .pr atual sem debug
 */
async function runWithoutDebug() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('Nenhum arquivo aberto para executar');
        return;
    }

    const filePath = editor.document.uri.fsPath;
    if (!filePath.endsWith('.pr')) {
        vscode.window.showErrorMessage('O arquivo atual não é um arquivo .pr');
        return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('Nenhum workspace aberto');
        return;
    }

    // Mostrar output channel
    const outputChannel = vscode.window.createOutputChannel('Por Do Sol Run');
    outputChannel.show(true);

    try {
        outputChannel.appendLine('[Por Do Sol] Iniciando execução sem debug...');
        outputChannel.appendLine(`[Por Do Sol] Arquivo: ${filePath}`);

        // Localizar binários
        const binarios = await localizarBinarios(workspaceFolder);
        if (!toolchainPronta(binarios)) {
            outputChannel.appendLine('[Por Do Sol] Erro: Binários não encontrados');
            outputChannel.appendLine(`[Por Do Sol] Compilador: ${binarios.compilador.caminho} (${binarios.compilador.origem})`);
            outputChannel.appendLine(`[Por Do Sol] Interpretador: ${binarios.interpretador.caminho} (${binarios.interpretador.origem})`);
            vscode.window.showErrorMessage('Binários não encontrados. Configure PORDOSOL_COMPILADOR_PATH e PORDOSOL_INTERPRETADOR_PATH ou instale a ferramenta CLI.');
            return;
        }

        outputChannel.appendLine(`[Por Do Sol] Compilador: ${binarios.compilador.caminho}`);
        outputChannel.appendLine(`[Por Do Sol] Interpretador: ${binarios.interpretador.caminho}`);

        // Verificar se precisa compilar
        const pbcPath = filePath.replace(/\.pr$/, '.pbc');
        const needsCompile = !fs.existsSync(pbcPath) || await precisaRecompilar(filePath, pbcPath);

        if (needsCompile) {
            outputChannel.appendLine('[Por Do Sol] Compilando...');
            await compilarArquivo(filePath, binarios.compilador.caminho, workspaceFolder, outputChannel);
        } else {
            outputChannel.appendLine('[Por Do Sol] Bytecode atualizado, pulando compilação');
        }

        // Executar
        outputChannel.appendLine('[Por Do Sol] Executando...');
        await executarArquivo(pbcPath, binarios.interpretador.caminho, workspaceFolder, outputChannel);

        outputChannel.appendLine('[Por Do Sol] Execução concluída com sucesso');
    } catch (error) {
        outputChannel.appendLine(`[Por Do Sol] Erro: ${error instanceof Error ? error.message : String(error)}`);
        vscode.window.showErrorMessage(`Erro na execução: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * Compila um arquivo .pr para .pbc
 */
async function compilarArquivo(
    arquivoPr: string,
    compiladorPath: string,
    workspaceFolder: string,
    outputChannel: vscode.OutputChannel
): Promise<void> {
    return new Promise((resolve, reject) => {
        const proc = spawn(compiladorPath, ['--target=bytecode', arquivoPr], {
            cwd: workspaceFolder,
            stdio: 'pipe'
        });

        proc.stdout.on('data', data => outputChannel.append(data.toString()));
        proc.stderr.on('data', data => outputChannel.append(data.toString()));

        proc.on('close', (code) => {
            if (code === 0) {
                outputChannel.appendLine('[Por Do Sol] Compilação concluída com sucesso');
                resolve();
            } else {
                outputChannel.appendLine(`[Por Do Sol] Compilação falhou com código ${code}`);
                reject(new Error(`Compilação falhou com código ${code}`));
            }
        });

        proc.on('error', (err) => {
            outputChannel.appendLine(`[Por Do Sol] Erro ao executar compilador: ${err.message}`);
            reject(err);
        });
    });
}

/**
 * Executa um arquivo .pbc
 */
async function executarArquivo(
    arquivoPbc: string,
    interpretadorPath: string,
    workspaceFolder: string,
    outputChannel: vscode.OutputChannel
): Promise<void> {
    return new Promise((resolve, reject) => {
        const proc = spawn(interpretadorPath, [arquivoPbc], {
            cwd: workspaceFolder,
            stdio: 'pipe'
        });

        proc.stdout.on('data', data => outputChannel.append(data.toString()));
        proc.stderr.on('data', data => outputChannel.append(data.toString()));

        proc.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Execução falhou com código ${code}`));
            }
        });

        proc.on('error', (err) => {
            outputChannel.appendLine(`[Por Do Sol] Erro ao executar interpretador: ${err.message}`);
            reject(err);
        });
    });
}

/**
 * Inicia debug detectando automaticamente se há breakpoints
 */
async function startDebug() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('Nenhum arquivo aberto para depurar');
        return;
    }

    const filePath = editor.document.uri.fsPath;
    if (!filePath.endsWith('.pr')) {
        vscode.window.showErrorMessage('O arquivo atual não é um arquivo .pr');
        return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('Nenhum workspace aberto');
        return;
    }

    // Detectar se há breakpoints no arquivo atual
    const breakpoints = vscode.debug.breakpoints;
    const hasBreakpoints = breakpoints.some(bp => 
        bp instanceof vscode.SourceBreakpoint && 
        bp.location.uri.fsPath === filePath
    );

    // Localizar binários
    const binarios = await localizarBinarios(workspaceFolder);
    if (!toolchainPronta(binarios)) {
        vscode.window.showErrorMessage('Binários não encontrados. Configure PORDOSOL_COMPILADOR_PATH e PORDOSOL_INTERPRETADOR_PATH ou instale a ferramenta CLI.');
        return;
    }

    // Criar configuração de debug
    const debugConfig: vscode.DebugConfiguration = {
        type: 'pordosol',
        request: 'launch',
        name: hasBreakpoints ? 'Depurar Por Do Sol (Modo Debug)' : 'Executar Por Do Sol (Play)',
        program: filePath,
        cwd: workspaceFolder,
        interpreterPath: binarios.interpretador.caminho,
        compiladorPath: binarios.compilador.caminho,
        args: []
    };

    // Iniciar debug
    try {
        const success = await vscode.debug.startDebugging(undefined, debugConfig);
        if (!success) {
            vscode.window.showErrorMessage('Falha ao iniciar debug');
        }
    } catch (error) {
        vscode.window.showErrorMessage(`Erro ao iniciar debug: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * Compila o arquivo .pr atual
 */
async function compileFile() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('Nenhum arquivo aberto para compilar');
        return;
    }

    const filePath = editor.document.uri.fsPath;
    if (!filePath.endsWith('.pr')) {
        vscode.window.showErrorMessage('O arquivo atual não é um arquivo .pr');
        return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('Nenhum workspace aberto');
        return;
    }

    // Mostrar output channel
    const outputChannel = vscode.window.createOutputChannel('Por Do Sol Compile');
    outputChannel.show(true);

    try {
        outputChannel.appendLine('[Por Do Sol] Iniciando compilação...');
        outputChannel.appendLine(`[Por Do Sol] Arquivo: ${filePath}`);

        // Localizar binários
        const binarios = await localizarBinarios(workspaceFolder);
        if (!toolchainPronta(binarios)) {
            outputChannel.appendLine('[Por Do Sol] Erro: Binários não encontrados');
            outputChannel.appendLine(`[Por Do Sol] Compilador: ${binarios.compilador.caminho} (${binarios.compilador.origem})`);
            vscode.window.showErrorMessage('Binários não encontrados. Configure PORDOSOL_COMPILADOR_PATH e PORDOSOL_INTERPRETADOR_PATH ou instale a ferramenta CLI.');
            return;
        }

        outputChannel.appendLine(`[Por Do Sol] Compilador: ${binarios.compilador.caminho}`);

        // Compilar
        await compilarArquivo(filePath, binarios.compilador.caminho, workspaceFolder, outputChannel);

        outputChannel.appendLine('[Por Do Sol] Compilação concluída com sucesso');
        vscode.window.showInformationMessage('Compilação concluída com sucesso');
    } catch (error) {
        outputChannel.appendLine(`[Por Do Sol] Erro: ${error instanceof Error ? error.message : String(error)}`);
        vscode.window.showErrorMessage(`Erro na compilação: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * Detecta se é um projeto Por do Sol e cria configuração de launch automaticamente
 */
async function detectAndCreateLaunchConfiguration() {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        console.log('[Por Do Sol] Nenhum workspace encontrado');
        return;
    }

    const workspacePath = workspaceFolder.uri.fsPath;
    const vscodeDir = path.join(workspacePath, '.vscode');
    const launchJsonPath = path.join(vscodeDir, 'launch.json');

    console.log(`[Por Do Sol] Verificando workspace: ${workspacePath}`);

    // Verificar se launch.json já existe
    if (fs.existsSync(launchJsonPath)) {
        console.log('[Por Do Sol] launch.json já existe, pulando criação');
        return;
    }

    // Verificar se é um projeto Por do Sol (tem arquivos .pr ou pordosol.proj)
    const hasPrFiles = await hasFilesWithExtension(workspacePath, '.pr');
    const hasProjectFile = fs.existsSync(path.join(workspacePath, 'pordosol.proj'));

    console.log(`[Por Do Sol] hasPrFiles: ${hasPrFiles}, hasProjectFile: ${hasProjectFile}`);

    if (!hasPrFiles && !hasProjectFile) {
        console.log('[Por Do Sol] Não é um projeto Por do Sol, pulando criação');
        return;
    }

    // Criar configuração automaticamente
    try {
        console.log('[Por Do Sol] Criando configuração de launch...');
        await createLaunchConfiguration();
        vscode.window.showInformationMessage('Configuração de debug criada automaticamente para Por do Sol');
        console.log('[Por Do Sol] Configuração criada com sucesso');
    } catch (error) {
        // Silenciosamente falhar se não conseguir criar
        console.error('[Por Do Sol] Erro ao criar configuração de launch:', error);
        vscode.window.showErrorMessage(`Erro ao criar configuração: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * Cria o arquivo launch.json com configurações para Por do Sol
 */
async function createLaunchConfiguration() {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('Nenhum workspace aberto');
        return;
    }

    const workspacePath = workspaceFolder.uri.fsPath;
    const vscodeDir = path.join(workspacePath, '.vscode');
    const launchJsonPath = path.join(vscodeDir, 'launch.json');

    // Criar diretório .vscode se não existir
    if (!fs.existsSync(vscodeDir)) {
        fs.mkdirSync(vscodeDir, { recursive: true });
    }

    // Configuração padrão
    const launchConfig = {
        "version": "0.2.0",
        "configurations": [
            {
                "type": "pordosol",
                "request": "launch",
                "name": "Executar Por Do Sol (Play)",
                "program": "${file}",
                "cwd": "${workspaceFolder}",
                "interpreterPath": "",
                "compiladorPath": "",
                "args": []
            },
            {
                "type": "pordosol",
                "request": "launch",
                "name": "Depurar Por Do Sol (Modo Debug)",
                "program": "${file}",
                "cwd": "${workspaceFolder}",
                "interpreterPath": "",
                "compiladorPath": "",
                "args": []
            }
        ]
    };

    // Escrever arquivo
    fs.writeFileSync(launchJsonPath, JSON.stringify(launchConfig, null, 4), 'utf-8');
}

/**
 * Verifica se existem arquivos com a extensão especificada no diretório
 */
async function hasFilesWithExtension(dir: string, ext: string): Promise<boolean> {
    try {
        const files = fs.readdirSync(dir);
        return files.some(file => file.endsWith(ext));
    } catch {
        return false;
    }
}