import assertRevert from './helpers/assertRevert.js';
import { deployContract, wallets } from './utils.js';
import { ethers } from 'ethers';
import { BLOCK_GAS_LIMIT } from './helpers/constants.js';
import { hashUint256Array } from './helpers/hash.js';

const OP = require('./helpers/constants');
const Verifier = artifacts.require('./SampleVerifierMock');
// const Verifier = artifacts.require('./SampleVerifier');
const Enforcer = artifacts.require('./EnforcerMock');
const EthRuntime = artifacts.require('./EthereumRuntime');

const DisputeState = {
  Initialised: 0,
  SolverTurn: 1,
  ChallengerTurn: 2,
  FoundDiff: 3,
  Ended: 4,
};

let verifier;
let enforcer;
let ethRuntime;

let sampleState = ethers.utils.formatBytes32String('state');
let sampleState2 = ethers.utils.formatBytes32String('state2');
let sampleProof = ethers.utils.solidityKeccak256(
  ['bytes32', 'bytes32'],
  [sampleState, sampleState]
);

let sampleProof2 = ethers.utils.solidityKeccak256(
  ['bytes32', 'bytes32'],
  [sampleState2, sampleState2]
);

contract('SampleVerifierMock', () => {
  /*
   * Dispute:
   *  0: executionId
   *  1: challenger
   *  2: solverComputation
   *  3: challengerComputation
   *  4: left
   *  5: right
   *  6: timeout
   *  7: state
   *  8: result
   */
  let parseDispute = async (disputeId) => {
    let dispute = await verifier.disputes(disputeId);
    return {
      executionId: dispute[0],
      challenger: dispute[1],
      timeout: dispute[6],
      state: dispute[7],
      result: dispute[8],
    };
  };

  let getDisputeIdFromEvent = async (tx) => {
    return (await tx.wait()).events[0].topics[1];
  };

  let generateExecId = () => {
    return ethers.utils.formatBytes32String(Date.now().toString());
  };

  before(async () => {
    verifier = await deployContract(Verifier, 100);
    enforcer = await deployContract(Enforcer);
    ethRuntime = await deployContract(EthRuntime);
    await verifier.setEnforcer(enforcer.address);
    await verifier.setRuntime(ethRuntime.address);
  });

  it('should have timeout set', async () => {
    assert.equal(await verifier.timeoutDuration(), 100, 'timeout not set');
  });

  it('have enforcer address set', async () => {
    assert.equal(await verifier.enforcer(), enforcer.address, 'enforcer not set');
  });

  it('should allow enforcer to initGame', async () => {
    // fake enforcer
    await verifier.setEnforcer(wallets[0].address);
    let tx = await verifier.initGame(
      generateExecId(),
      ethers.utils.formatBytes32String('execHashsolver'), 10,
      ethers.utils.formatBytes32String('execHashChallenger'), 10,
      wallets[1].address
    );
    let disputeId = await getDisputeIdFromEvent(tx);
    let dispute = await parseDispute(disputeId);
    assert.equal(dispute.challenger, wallets[1].address, 'challenger address incorrect');
    assert.equal(dispute.state, 0, 'state not Initialised');
    assert.equal(dispute.result, 2, 'result not Undecided');
  });

  describe('when Initialised', async () => {
    let disputeId;
    beforeEach('setup dispute', async () => {
      let tx = await verifier.initGame(
        generateExecId(),
        sampleProof, 2,
        sampleProof2, 2,
        wallets[1].address
      );
      disputeId = await getDisputeIdFromEvent(tx);
    });

    it('should change dispute state to SolverTurn if correct proofs', async () => {
      let dispute = await parseDispute(disputeId);
      await verifier.solverProofs(disputeId, [sampleState], sampleState, [sampleState], sampleState);
      dispute = await parseDispute(disputeId);
      assert.equal(dispute.state, 1, 'state not SolverTurn');
    });

    it('cannot process with incorrect start proofs', async () => {
      // change enforcer to EnforcerMock address
      await verifier.setEnforcer(enforcer.address);
      assertRevert(verifier.solverProofs(disputeId, [sampleState2], sampleState2, [sampleState], sampleState));
      await verifier.setEnforcer(wallets[0].address);
      let dispute = await parseDispute(disputeId);
      assert.equal(dispute.state, DisputeState.Initialised, 'state not Initialised');
      assert.equal(dispute.result, 2, 'result not undecided');
    });

    it('cannot process with incorrect end proofs', async () => {
      // change enforcer to EnforcerMock address
      await verifier.setEnforcer(enforcer.address);
      assertRevert(verifier.solverProofs(disputeId, [sampleState], sampleState, [sampleState2], sampleState2));
      await verifier.setEnforcer(wallets[0].address);
      let dispute = await parseDispute(disputeId);
      assert.equal(dispute.state, DisputeState.Initialised, 'state not Initialised');
      assert.equal(dispute.result, 2, 'result not undecided');
    });
  });

  it('should allow modification of timeout in mock', async () => {
    let tx = await verifier.initGame(
      generateExecId(),
      sampleProof, 2,
      sampleProof2, 2,
      wallets[1].address
    );
    let disputeId = await getDisputeIdFromEvent(tx);
    await verifier.setTimeout(
      disputeId,
      1 // already timed out
    );
    let dispute = await parseDispute(disputeId);
    assert.equal(dispute.timeout, 1, 'timeout not set');
  });

  describe('when timed out', async () => {
    let solverLostStates = [
      DisputeState.Initialised,
      DisputeState.SolverTurn,
      DisputeState.FoundDiff,
    ];
    solverLostStates.forEach((state) => {
      it(`can trigger timeout and challenger is considered correct when state is ${state}`, async () => {
        let tx = await verifier.initGame(
          generateExecId(),
          sampleProof, 2,
          sampleProof2, 2,
          wallets[1].address
        );
        let disputeId = await getDisputeIdFromEvent(tx);

        assertRevert(verifier.claimTimeout(disputeId));

        await verifier.setState(disputeId, state);
        await verifier.setTimeout(
          disputeId,
          1 // already timed out
        );

        await verifier.setEnforcer(enforcer.address);
        await verifier.claimTimeout(disputeId);
        await verifier.setEnforcer(wallets[0].address);
        let dispute = await parseDispute(disputeId);
        assert.equal(dispute.state, DisputeState.Ended, 'state not Ended');
        assert.equal(dispute.result, 1, 'result not ChallengerCorrect');
      });
    });

    it('can trigger timeout and solver is considered correct when state is ChallengerTurn', async () => {
      let tx = await verifier.initGame(
        generateExecId(),
        sampleProof, 2,
        sampleProof2, 2,
        wallets[1].address
      );
      let disputeId = await getDisputeIdFromEvent(tx);

      assertRevert(verifier.claimTimeout(disputeId));

      await verifier.setState(disputeId, DisputeState.ChallengerTurn);
      await verifier.setTimeout(
        disputeId,
        1 // already timed out
      );

      await verifier.setEnforcer(enforcer.address);
      await verifier.claimTimeout(disputeId);
      await verifier.setEnforcer(wallets[0].address);
      let dispute = await parseDispute(disputeId);
      assert.equal(dispute.state, DisputeState.Ended, 'state not Ended');
      assert.equal(dispute.result, 0, 'state not SolverCorrect');
    });
  });

  describe('when FoundDiff', async () => {
    const code = '0x' + OP.PUSH1 + '03' + OP.PUSH1 + '05' + OP.ADD;

    // TODO use state hash function
    let solverHash = hashUint256Array([8], 0);
    let solverStep = 3;
    let challengerHash = hashUint256Array([9], 0);
    let challengerStep = 3;
    let disputeId;

    beforeEach('setup dispute', async () => {
      let tx = await verifier.initGame(
        generateExecId(),
        solverHash, solverStep,
        challengerHash, challengerStep,
        wallets[1].address
      );
      disputeId = await getDisputeIdFromEvent(tx);
      await verifier.setState(disputeId, DisputeState.FoundDiff);
      await verifier.setLeft(disputeId, hashUint256Array([5, 3], 0), 4);
      await verifier.setRight(disputeId, hashUint256Array([8], 0), 5);
      await verifier.setEnforcer(enforcer.address);
    });

    afterEach('clean up', async () => {
      await verifier.setEnforcer(wallets[0].address);
    });

    it('should allow solver to submit correct state and win', async () => {
      await verifier.detailExecution(
        disputeId,
        code,
        '0x',
        [4, 0, BLOCK_GAS_LIMIT, BLOCK_GAS_LIMIT],
        [5, 3],
        '0x',
        [],
        '0x',
        '0x0000000000000000000000000000000000000000000000000000000000000000'
      );
      let dispute = await parseDispute(disputeId);
      assert.equal(dispute.state, DisputeState.Ended, 'dispute not Ended');
      assert.equal(dispute.result, 0, 'solver not win');
    });

    it('should allow solver to submit incorrect state and lose', async () => {
      await verifier.setLeft(disputeId, hashUint256Array([5, 4], 0), 4);
      await verifier.detailExecution(
        disputeId,
        code,
        '0x',
        [4, 0, BLOCK_GAS_LIMIT, BLOCK_GAS_LIMIT],
        [5, 4],
        '0x',
        [],
        '0x',
        '0x0000000000000000000000000000000000000000000000000000000000000000'
      );
      let dispute = await parseDispute(disputeId);
      assert.equal(dispute.state, DisputeState.Ended, 'dispute not Ended');
      assert.equal(dispute.result, 1, 'solver not lose');
    });
  });
});
