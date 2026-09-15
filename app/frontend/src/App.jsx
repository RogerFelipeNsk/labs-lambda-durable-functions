import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DetalheBoleto from "./components/DetalheBoleto.jsx";
import EmitirBoleto from "./components/EmitirBoleto.jsx";
import ListaBoletos from "./components/ListaBoletos.jsx";
import {
  AO_CHEGAR_EVENTO,
  AO_MUDAR_BOLETO,
  LISTAR_BOLETOS,
  LISTAR_EVENTOS,
  graphql,
} from "./cliente.js";

export default function App() {
  const [boletos, setBoletos] = useState({});
  const [eventos, setEventos] = useState({});
  const [selecionado, setSelecionado] = useState(null);
  const [conexao, setConexao] = useState("conectando");
  const [aviso, setAviso] = useState(null);

  // Guarda quais boletos ja tiveram a timeline carregada do banco, para nao
  // refazer a query toda vez que o usuario troca de card.
  const timelinesCarregadas = useRef(new Set());

  // A API e o workflow escrevem no mesmo boleto quase ao mesmo tempo, entao
  // dois snapshots podem chegar fora de ordem. `updatedAt` desempata: um
  // snapshot mais velho nunca sobrescreve um mais novo, senao a tela piscaria
  // voltando de "baixado" para "emitido".
  const guardarBoleto = useCallback((boleto) => {
    if (!boleto?.id) return;
    setBoletos((atual) => {
      const anterior = atual[boleto.id];
      if (anterior?.updatedAt && boleto.updatedAt && boleto.updatedAt < anterior.updatedAt) {
        return atual;
      }
      return { ...atual, [boleto.id]: { ...anterior, ...boleto } };
    });
  }, []);

  const guardarEvento = useCallback((evento) => {
    if (!evento?.boletoId) return;
    setEventos((atual) => {
      const lista = atual[evento.boletoId] ?? [];
      // A subscription pode reentregar um evento; `seq` desempata.
      if (lista.some((e) => e.seq === evento.seq)) return atual;
      return { ...atual, [evento.boletoId]: [...lista, evento].sort((a, b) => a.seq - b.seq) };
    });
  }, []);

  // Carga inicial + as duas subscriptions. Tudo que acontece daqui em diante
  // chega por push do AppSync: a tela nunca faz polling.
  useEffect(() => {
    let vivo = true;

    graphql
      .graphql({ query: LISTAR_BOLETOS })
      .then(({ data }) => {
        if (!vivo) return;
        const mapa = {};
        for (const b of data.listBoletos.items) mapa[b.id] = b;
        setBoletos(mapa);
      })
      .catch((erro) => setAviso(`Falha ao carregar boletos: ${erro.message ?? erro}`));

    const assinaturas = [
      graphql.graphql({ query: AO_MUDAR_BOLETO }).subscribe({
        next: ({ data }) => {
          setConexao("ok");
          guardarBoleto(data.onBoletoChanged);
        },
        error: (erro) => {
          setConexao("erro");
          setAviso(`Subscription de boletos caiu: ${erro?.error?.errors?.[0]?.message ?? "erro desconhecido"}`);
        },
      }),
      graphql.graphql({ query: AO_CHEGAR_EVENTO }).subscribe({
        next: ({ data }) => {
          setConexao("ok");
          guardarEvento(data.onEvent);
        },
        error: () => setConexao("erro"),
      }),
    ];

    // Se nada explodiu em 2s, a conexao websocket subiu.
    const t = setTimeout(() => setConexao((c) => (c === "conectando" ? "ok" : c)), 2000);

    return () => {
      vivo = false;
      clearTimeout(t);
      for (const s of assinaturas) s.unsubscribe();
    };
  }, [guardarBoleto, guardarEvento]);

  // Ao abrir um boleto, busca a timeline que ja estava gravada antes de a tela
  // existir. Os eventos novos continuam chegando pela subscription.
  useEffect(() => {
    if (!selecionado || timelinesCarregadas.current.has(selecionado)) return;
    timelinesCarregadas.current.add(selecionado);
    graphql
      .graphql({ query: LISTAR_EVENTOS, variables: { boletoId: selecionado } })
      .then(({ data }) => {
        setEventos((atual) => {
          const jaVistos = new Set((atual[selecionado] ?? []).map((e) => e.seq));
          const novos = data.listEvents.items.filter((e) => !jaVistos.has(e.seq));
          return {
            ...atual,
            [selecionado]: [...(atual[selecionado] ?? []), ...novos].sort((a, b) => a.seq - b.seq),
          };
        });
      })
      .catch(() => timelinesCarregadas.current.delete(selecionado));
  }, [selecionado]);

  const ordenados = useMemo(
    () => Object.values(boletos).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    [boletos],
  );

  const boletoAberto = selecionado ? boletos[selecionado] : null;

  return (
    <div className="app">
      <header className="cabecalho">
        <div>
          <h1>Mesa de conciliação</h1>
          <p className="subtitulo">
            Cobrança conduzida por uma <strong>AWS Lambda durable function</strong> — emissão,
            espera pelo pagamento, baixa, extrato e conciliação em uma única execução.
          </p>
        </div>
        <span className={`conexao ${conexao}`}>
          <i />
          {conexao === "ok" ? "tempo real ligado" : conexao === "erro" ? "sem conexão" : "conectando…"}
        </span>
      </header>

      {aviso && (
        <div className="aviso" role="alert">
          {aviso}
          <button type="button" onClick={() => setAviso(null)} aria-label="fechar">
            ×
          </button>
        </div>
      )}

      <main className="grade">
        <section className="coluna-lateral">
          <EmitirBoleto aoEmitir={guardarBoleto} aoFalhar={setAviso} aoSelecionar={setSelecionado} />
          <ListaBoletos
            boletos={ordenados}
            selecionado={selecionado}
            aoSelecionar={setSelecionado}
          />
        </section>

        <section className="coluna-principal">
          {boletoAberto ? (
            <DetalheBoleto
              boleto={boletoAberto}
              eventos={eventos[boletoAberto.id] ?? []}
              aoFalhar={setAviso}
            />
          ) : (
            <div className="vazio">
              <h2>Nenhuma cobrança aberta</h2>
              <p>
                Emita um boleto ao lado. Ele vai ficar em <em>aguardando pagamento</em> com a
                execução durable suspensa — sem consumir compute — até você clicar em “Registrar
                pagamento”, que é o webhook do banco resolvendo o callback.
              </p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
