import { ETAPAS, posicaoDoStatus } from "../dominio.js";

/**
 * Desenha as tres etapas do workflow e marca onde a execucao esta.
 *
 * A etapa de aprovacao ganha tratamento proprio porque e a unica em que a
 * execucao esta suspensa de verdade — nao "processando". Em falha ou
 * cancelamento o status nao diz onde paramos, so que paramos; por isso caimos
 * no `stage`, que o backend grava a cada transicao.
 */
export default function Pipeline({ status, stage }) {
  const [indice, situacao] = posicaoDoStatus(status);
  const indiceEfetivo =
    indice >= 0 ? indice : Math.max(ETAPAS.findIndex((e) => e.chave === stage), 0);

  return (
    <ol className="pipeline">
      {ETAPAS.map((etapa, i) => {
        let estado = "pendente";
        if (i < indiceEfetivo) estado = "concluida";
        else if (i === indiceEfetivo) estado = situacao;

        return (
          <li key={etapa.chave} className={`etapa ${estado}`}>
            <span className="marcador">{estado === "concluida" ? "✓" : i + 1}</span>
            <span className="rotulo">
              <strong>{etapa.titulo}</strong>
              <em>{estado === "esperando" ? "suspensa · custo zero" : etapa.detalhe}</em>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
